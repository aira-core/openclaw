import crypto from "node:crypto";
import fssync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { buildSkMessageKey, buildSkToolCallKey } from "./keys.js";
import { parseSessionFileContext, parseTranscriptLineToEvents } from "./parser.js";
import { redactSensitiveText, truncateText } from "./redact.js";

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

type ExecutionSessionEntityType = "PROJECT" | "WORK_ITEM" | "TASK";

type ExecutionSessionState = "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

type SkMessageRole = "system" | "user" | "assistant" | "tool";

type SkAttachSessionRequest = {
  entityType: ExecutionSessionEntityType;
  /** Exactly one of entityId or entityExternalId is required. */
  entityId?: string;
  entityExternalId?: string;
  sessionKey: string;
  state: ExecutionSessionState;
  runId?: string | null;
  jobId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
};

type SkRecordMessageRequest = {
  sessionKey: string;
  entityType: ExecutionSessionEntityType;
  entityId?: string;
  entityExternalId?: string;
  messageKey: string;
  role: SkMessageRole;
  content: string | null;
  occurredAt?: string | null;
  metadata?: Record<string, unknown> | null;
};

type SkToolCallStatus = "STARTED" | "SUCCEEDED" | "FAILED";

type SkRecordToolCallRequest = {
  sessionKey: string;
  entityType: ExecutionSessionEntityType;
  entityId?: string;
  entityExternalId?: string;
  toolCallKey: string;
  toolName: string;
  status: SkToolCallStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  inputJson?: unknown;
  outputJson?: unknown;
  error?: string | null;
};

type SessionBinding = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  label: string;
  entityType: ExecutionSessionEntityType;
  entityExternalId: string;
};

type SkConfig = {
  baseUrl: string;
  token?: string;
  authHeader?: string;
  attachPath: string;
  messagesPath: string;
  toolCallsPath: string;
  timeoutMs: number;
  maxTextChars: number;
  maxToolResultChars: number;
  agentsAllowlist?: string[];
};

type ReconcileFilter = {
  stateDir: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  maxSessions?: number;
};

export type ReconcileMode = "dry-run" | "fix";

export type ReconcileSessionReport = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  label: string;
  entityType: ExecutionSessionEntityType;
  entityExternalId: string;
  transcriptPath: string;
  counts: { messages: number; toolCalls: number };
  timestamps: { firstMs?: number; lastMs?: number };
  preview?: {
    messages: Array<{ messageKey: string; role: SkMessageRole; occurredAt?: string | null }>;
    toolCalls: Array<{ toolCallKey: string; toolName: string; status: SkToolCallStatus }>;
  };
};

export type ReconcileReport = {
  mode: ReconcileMode;
  stateDir: string;
  baseUrl: string;
  sessionsScanned: number;
  sessionsMatched: number;
  sessionsSkippedNoBinding: number;
  sessionsSkippedByFilter: number;
  totals: { messages: number; toolCalls: number };
  sessions: ReconcileSessionReport[];
};

function resolveAuthHeaders(cfg: { token?: string; authHeader?: string }): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cfg.authHeader) {
    const idx = cfg.authHeader.indexOf(":");
    if (idx !== -1) {
      const k = cfg.authHeader.slice(0, idx).trim();
      const v = cfg.authHeader.slice(idx + 1).trim();
      if (k && v) {
        headers[k] = v;
      }
    }
  } else if (cfg.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }
  return headers;
}

function joinUrl(baseUrl: string, p: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = p.startsWith("/") ? p : `/${p}`;
  return `${base}${suffix}`;
}

async function postJson(params: {
  url: string;
  payload: unknown;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(params.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...params.headers,
      },
      body: JSON.stringify(params.payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function toIsoOrNull(tsMs: number | undefined): string | null {
  if (!tsMs || !Number.isFinite(tsMs)) {
    return null;
  }
  return new Date(tsMs).toISOString();
}

function normalizeSkRole(role: string): SkMessageRole | null {
  const r = String(role || "")
    .trim()
    .toLowerCase();
  if (r === "system" || r === "user" || r === "assistant") {
    return r as SkMessageRole;
  }
  if (r === "tool" || r === "toolresult" || r === "tool_result") {
    return "tool";
  }
  return null;
}

function redactTextWithCoreConfig(text: string, core: OpenClawConfig): string {
  const logging = core.logging;
  const mode = logging?.redactSensitive === "off" ? "off" : "tools";
  const patterns = logging?.redactPatterns;
  return redactSensitiveText(text, { mode, patterns });
}

function normalizeMessagePayload(
  payload: SkRecordMessageRequest,
  params: { coreConfig: OpenClawConfig; maxTextChars: number },
): SkRecordMessageRequest {
  const contentRaw = payload.content;
  const safeContent =
    typeof contentRaw === "string"
      ? truncateText(redactTextWithCoreConfig(contentRaw, params.coreConfig), params.maxTextChars)
      : null;
  if (safeContent === contentRaw) {
    return payload;
  }
  return { ...payload, content: safeContent };
}

function normalizeToolCallPayload(
  payload: SkRecordToolCallRequest,
  params: { coreConfig: OpenClawConfig; maxToolResultChars: number },
): SkRecordToolCallRequest {
  const inputJson =
    typeof payload.inputJson === "string"
      ? truncateText(redactTextWithCoreConfig(payload.inputJson, params.coreConfig), 4000)
      : payload.inputJson;

  const outputJson =
    typeof payload.outputJson === "string"
      ? truncateText(
          redactTextWithCoreConfig(payload.outputJson, params.coreConfig),
          params.maxToolResultChars,
        )
      : payload.outputJson;

  const error =
    typeof payload.error === "string"
      ? truncateText(
          redactTextWithCoreConfig(payload.error, params.coreConfig),
          params.maxToolResultChars,
        )
      : payload.error;

  if (
    inputJson === payload.inputJson &&
    outputJson === payload.outputJson &&
    error === payload.error
  ) {
    return payload;
  }

  return {
    ...payload,
    inputJson,
    outputJson,
    error,
  };
}

async function listSessionJsonlFiles(params: {
  stateDir: string;
  agentsAllowlist?: string[];
  agentIdFilter?: string;
}): Promise<string[]> {
  const agentsDir = path.join(params.stateDir, "agents");
  let agentEntries: Array<{ name: string; isDir: boolean }> = [];
  try {
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    agentEntries = entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }

  const allow = params.agentsAllowlist?.length
    ? new Set(params.agentsAllowlist.map((v) => v.trim()).filter(Boolean))
    : null;

  const out: string[] = [];
  for (const entry of agentEntries) {
    if (!entry.isDir) continue;
    if (params.agentIdFilter && entry.name !== params.agentIdFilter) continue;
    if (allow && !allow.has(entry.name)) continue;

    const sessionsDir = path.join(agentsDir, entry.name, "sessions");
    let files: string[] = [];
    try {
      files = await fs.readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      if (name.includes(".deleted.") || name.includes(".bak.")) continue;
      out.push(path.join(sessionsDir, name));
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function loadAgentSessionsIndex(
  stateDir: string,
  agentId: string,
): Promise<Map<string, { sessionKey: string; label?: string }> | null> {
  const sessionsPath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
  const raw = await fs.readFile(sessionsPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return null;
  }
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw) as Record<string, any>;
  } catch {
    return null;
  }

  const bySessionId = new Map<string, { sessionKey: string; label?: string }>();
  for (const [sessionKey, entry] of Object.entries(parsed)) {
    const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId.trim() : "";
    if (!sessionId) continue;
    const label = typeof entry?.label === "string" ? entry.label.trim() : undefined;
    if (!bySessionId.has(sessionId)) {
      bySessionId.set(sessionId, { sessionKey, label });
    }
  }

  return bySessionId;
}

type ParsedSkRoutingLabel =
  | { kind: "direct"; entityType: ExecutionSessionEntityType; entityExternalId: string }
  | { kind: "taskHash"; label: string; hash: string };

function parseSkRoutingLabel(label: string): ParsedSkRoutingLabel | null {
  const raw = String(label || "").trim();
  if (!raw) return null;

  const mDirect = /^SK:(PROJECT|WORK_ITEM|TASK):(.*)$/.exec(raw);
  if (mDirect) {
    const entityType = mDirect[1] as ExecutionSessionEntityType;
    const entityExternalId = (mDirect[2] || "").trim();
    if (!entityExternalId) return null;
    return { kind: "direct", entityType, entityExternalId };
  }

  const mHash = /^SK:TASKH:([0-9a-f]{16})$/i.exec(raw);
  if (mHash) {
    return { kind: "taskHash", label: raw, hash: mHash[1]!.toLowerCase() };
  }

  return null;
}

type LabelMapItem = { externalId: string; label: string; hash: string };

function resolveLabelMapPath(stateDir: string): string {
  const baseDir = path.basename(stateDir) === ".openclaw" ? path.dirname(stateDir) : stateDir;

  const raw =
    process.env.SUPER_KANBAN_LABEL_MAP_PATH?.trim() ||
    process.env.OPENCLAW_SUPER_KANBAN_LABEL_MAP_PATH?.trim() ||
    "";

  if (raw) {
    return path.isAbsolute(raw) ? raw : path.join(baseDir, raw);
  }

  return path.join(baseDir, "Exports", "label-map.json");
}

function normalizeLabelMapItems(value: unknown): LabelMapItem[] {
  const items: unknown[] = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Array.isArray((value as any).items)
      ? ((value as any).items as unknown[])
      : [];

  return items
    .filter(
      (it) =>
        it &&
        typeof it === "object" &&
        typeof (it as any).externalId === "string" &&
        typeof (it as any).label === "string" &&
        typeof (it as any).hash === "string",
    )
    .map((it) => ({
      externalId: String((it as any).externalId),
      label: String((it as any).label),
      hash: String((it as any).hash).toLowerCase(),
    }));
}

async function loadLabelMap(stateDir: string): Promise<LabelMapItem[]> {
  const filePath = resolveLabelMapPath(stateDir);
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  try {
    return normalizeLabelMapItems(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

async function appendLabelMapEntry(params: {
  stateDir: string;
  externalId: string;
  label: string;
  hash: string;
}): Promise<void> {
  const filePath = resolveLabelMapPath(params.stateDir);
  const items = await loadLabelMap(params.stateDir);

  const externalId = params.externalId.trim();
  const label = params.label.trim();
  const hash = params.hash.toLowerCase();
  if (!externalId || !label || !hash) return;

  if (items.some((it) => it.hash === hash || it.label === label || it.externalId === externalId)) {
    return;
  }

  const next: LabelMapItem[] = [...items, { externalId, label, hash }];
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function resolveTaskExternalIdFromHash(params: {
  stateDir: string;
  agentId: string;
  sessionId: string;
  label: string;
  hash: string;
  allowWriteLabelMap: boolean;
}): Promise<string | null> {
  const items = await loadLabelMap(params.stateDir);
  const hit = items.find((it) => it.hash === params.hash || it.label === params.label);
  if (hit?.externalId) {
    return hit.externalId;
  }

  const transcriptPath = path.join(
    params.stateDir,
    "agents",
    params.agentId,
    "sessions",
    `${params.sessionId}.jsonl`,
  );

  const fileCtx = parseSessionFileContext(transcriptPath);

  // Only scan a small prefix.
  const maxLines = 500;
  let scanned = 0;

  const extractCandidates = (text: string): string[] => {
    const out: string[] = [];
    const m = /\bexternalId\b\s*[:=]?\s*([^\s]+)/i.exec(text);
    if (m?.[1]) out.push(m[1]);
    for (const mm of text.matchAll(/\btask:[^\s\]})>,\"'`]+/g)) {
      out.push(mm[0]);
    }
    const normalized = out
      .map((v) =>
        v
          .trim()
          .replace(/^['"`]+/, "")
          .replace(/['"`]+$/, "")
          .replace(/[)\].,;]+$/, ""),
      )
      .filter(Boolean);
    return [...new Set(normalized)];
  };

  const stream = fssync.createReadStream(transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      scanned += 1;
      if (scanned > maxLines) break;
      const parsed = parseTranscriptLineToEvents({ ctx: fileCtx, line });
      if (!parsed) continue;
      for (const msg of parsed.messages) {
        const text = typeof msg.text === "string" ? msg.text : "";
        if (!text) continue;
        for (const candidate of extractCandidates(text)) {
          const computed = crypto
            .createHash("sha256")
            .update(candidate, "utf8")
            .digest("hex")
            .slice(0, 16);
          if (computed.toLowerCase() !== params.hash.toLowerCase()) continue;
          if (params.allowWriteLabelMap) {
            await appendLabelMapEntry({
              stateDir: params.stateDir,
              externalId: candidate,
              label: params.label,
              hash: params.hash,
            });
          }
          return candidate;
        }
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  return null;
}

async function resolveSessionBinding(params: {
  stateDir: string;
  agentId: string;
  sessionId: string;
  allowWriteLabelMap: boolean;
}): Promise<SessionBinding | null> {
  const idx = await loadAgentSessionsIndex(params.stateDir, params.agentId);
  const info = idx?.get(params.sessionId);
  if (!info?.sessionKey) {
    return null;
  }

  const label = info.label ?? "";
  const parsed = parseSkRoutingLabel(label);
  if (!parsed) {
    return null;
  }

  if (parsed.kind === "direct") {
    return {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: info.sessionKey,
      label,
      entityType: parsed.entityType,
      entityExternalId: parsed.entityExternalId,
    };
  }

  const externalId = await resolveTaskExternalIdFromHash({
    stateDir: params.stateDir,
    agentId: params.agentId,
    sessionId: params.sessionId,
    label: parsed.label,
    hash: parsed.hash,
    allowWriteLabelMap: params.allowWriteLabelMap,
  });

  if (!externalId) return null;

  return {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: info.sessionKey,
    label,
    entityType: "TASK",
    entityExternalId: externalId,
  };
}

async function ensureFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function reconcileOneSession(params: {
  mode: ReconcileMode;
  cfg: SkConfig;
  coreConfig: OpenClawConfig;
  binding: SessionBinding;
  transcriptPath: string;
  previewLimit: number;
  logger: Logger;
}): Promise<ReconcileSessionReport> {
  const fileCtx = parseSessionFileContext(params.transcriptPath);
  const headers = resolveAuthHeaders(params.cfg);

  let attached = false;
  const attach = async (startedAt: string | null) => {
    if (attached || params.mode !== "fix") return;

    const payload: SkAttachSessionRequest = {
      entityType: params.binding.entityType,
      entityExternalId: params.binding.entityExternalId,
      sessionKey: params.binding.sessionKey,
      state: "RUNNING",
      startedAt,
      endedAt: null,
    };

    const url = joinUrl(params.cfg.baseUrl, params.cfg.attachPath);
    await postJson({ url, payload, headers, timeoutMs: params.cfg.timeoutMs });
    attached = true;
  };

  const report: ReconcileSessionReport = {
    agentId: params.binding.agentId,
    sessionId: params.binding.sessionId,
    sessionKey: params.binding.sessionKey,
    label: params.binding.label,
    entityType: params.binding.entityType,
    entityExternalId: params.binding.entityExternalId,
    transcriptPath: params.transcriptPath,
    counts: { messages: 0, toolCalls: 0 },
    timestamps: {},
    preview: {
      messages: [],
      toolCalls: [],
    },
  };

  const stream = fssync.createReadStream(params.transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const parsed = parseTranscriptLineToEvents({ ctx: fileCtx, line });
      if (!parsed) continue;

      for (const msg of parsed.messages) {
        const role = normalizeSkRole(msg.role);
        if (!role) continue;

        const occurredAt = toIsoOrNull(msg.timestamp);
        const messageKey = buildSkMessageKey({
          sessionKey: params.binding.sessionKey,
          messageId: msg.messageId,
          role,
          occurredAtMs: msg.timestamp,
          content: msg.text,
        });

        if (!report.timestamps.firstMs && typeof msg.timestamp === "number") {
          report.timestamps.firstMs = msg.timestamp;
        }
        if (typeof msg.timestamp === "number") {
          report.timestamps.lastMs = msg.timestamp;
        }

        const rawPayload: SkRecordMessageRequest = {
          sessionKey: params.binding.sessionKey,
          entityType: params.binding.entityType,
          entityExternalId: params.binding.entityExternalId,
          messageKey,
          role,
          content: msg.text,
          occurredAt,
          metadata: {
            agentId: msg.agentId ?? null,
            sessionId: msg.sessionId,
            topicId: msg.topicId ?? null,
            messageId: msg.messageId ?? null,
            label: params.binding.label,
          },
        };

        const payload = normalizeMessagePayload(rawPayload, {
          coreConfig: params.coreConfig,
          maxTextChars: params.cfg.maxTextChars,
        });

        await attach(payload.occurredAt ?? null);

        if (params.mode === "fix") {
          const url = joinUrl(params.cfg.baseUrl, params.cfg.messagesPath);
          await postJson({ url, payload, headers, timeoutMs: params.cfg.timeoutMs });
        }

        report.counts.messages += 1;
        if (report.preview && report.preview.messages.length < params.previewLimit) {
          report.preview.messages.push({ messageKey, role, occurredAt });
        }
      }

      for (const tool of parsed.toolCalls) {
        if (!tool.toolCallId) continue;

        const tsIso = toIsoOrNull(tool.timestamp);
        const startedAt = tool.status === "STARTED" ? tsIso : null;
        const endedAt = tool.status === "SUCCEEDED" || tool.status === "FAILED" ? tsIso : null;

        if (!report.timestamps.firstMs && typeof tool.timestamp === "number") {
          report.timestamps.firstMs = tool.timestamp;
        }
        if (typeof tool.timestamp === "number") {
          report.timestamps.lastMs = tool.timestamp;
        }

        const toolCallKey = buildSkToolCallKey(params.binding.sessionKey, tool.toolCallId);

        const rawPayload: SkRecordToolCallRequest = {
          sessionKey: params.binding.sessionKey,
          entityType: params.binding.entityType,
          entityExternalId: params.binding.entityExternalId,
          toolCallKey,
          toolName: tool.toolName?.trim() || "unknown",
          status: tool.status,
          startedAt,
          endedAt,
          inputJson: tool.paramsText ?? undefined,
          outputJson: tool.resultText ?? undefined,
          error: tool.errorText ?? null,
        };

        const payload = normalizeToolCallPayload(rawPayload, {
          coreConfig: params.coreConfig,
          maxToolResultChars: params.cfg.maxToolResultChars,
        });

        await attach(payload.startedAt ?? payload.endedAt ?? null);

        if (params.mode === "fix") {
          const url = joinUrl(params.cfg.baseUrl, params.cfg.toolCallsPath);
          await postJson({ url, payload, headers, timeoutMs: params.cfg.timeoutMs });
        }

        report.counts.toolCalls += 1;
        if (report.preview && report.preview.toolCalls.length < params.previewLimit) {
          report.preview.toolCalls.push({
            toolCallKey,
            toolName: payload.toolName,
            status: payload.status,
          });
        }
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  return report;
}

export async function reconcileSuperKanban(params: {
  mode: ReconcileMode;
  filter: ReconcileFilter;
  cfg: SkConfig;
  coreConfig: OpenClawConfig;
  logger: Logger;
  previewLimit?: number;
}): Promise<ReconcileReport> {
  const previewLimit = Math.max(0, Math.floor(params.previewLimit ?? 3));

  const files = await listSessionJsonlFiles({
    stateDir: params.filter.stateDir,
    agentsAllowlist: params.cfg.agentsAllowlist,
    agentIdFilter: params.filter.agentId,
  });

  const report: ReconcileReport = {
    mode: params.mode,
    stateDir: params.filter.stateDir,
    baseUrl: params.cfg.baseUrl,
    sessionsScanned: files.length,
    sessionsMatched: 0,
    sessionsSkippedNoBinding: 0,
    sessionsSkippedByFilter: 0,
    totals: { messages: 0, toolCalls: 0 },
    sessions: [],
  };

  for (const absPath of files) {
    if (params.filter.maxSessions && report.sessionsMatched >= params.filter.maxSessions) {
      break;
    }

    const ctx = parseSessionFileContext(absPath);
    if (!ctx.agentId || !ctx.sessionId) {
      report.sessionsSkippedByFilter += 1;
      continue;
    }

    if (params.filter.sessionId && ctx.sessionId !== params.filter.sessionId) {
      report.sessionsSkippedByFilter += 1;
      continue;
    }

    // Transcript might not exist anymore.
    if (!(await ensureFileExists(absPath))) {
      report.sessionsSkippedByFilter += 1;
      continue;
    }

    const binding = await resolveSessionBinding({
      stateDir: params.filter.stateDir,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      allowWriteLabelMap: params.mode === "fix",
    });

    if (!binding) {
      report.sessionsSkippedNoBinding += 1;
      continue;
    }

    if (params.filter.sessionKey && binding.sessionKey !== params.filter.sessionKey) {
      report.sessionsSkippedByFilter += 1;
      continue;
    }

    // Only export sessions explicitly labeled with an SK routing label.
    const sessionReport = await reconcileOneSession({
      mode: params.mode,
      cfg: params.cfg,
      coreConfig: params.coreConfig,
      binding,
      transcriptPath: absPath,
      previewLimit,
      logger: params.logger,
    });

    report.sessionsMatched += 1;
    report.totals.messages += sessionReport.counts.messages;
    report.totals.toolCalls += sessionReport.counts.toolCalls;
    report.sessions.push(sessionReport);
  }

  return report;
}

export function formatReconcileReportText(report: ReconcileReport): string {
  const lines: string[] = [];
  lines.push(
    `Super-Kanban reconcile (${report.mode}) baseUrl=${report.baseUrl} stateDir=${report.stateDir}`,
  );
  lines.push(
    `Sessions: scanned=${report.sessionsScanned} matched=${report.sessionsMatched} skippedNoBinding=${report.sessionsSkippedNoBinding} skippedByFilter=${report.sessionsSkippedByFilter}`,
  );
  lines.push(`Totals: messages=${report.totals.messages} toolCalls=${report.totals.toolCalls}`);

  for (const s of report.sessions) {
    const first = s.timestamps.firstMs ? new Date(s.timestamps.firstMs).toISOString() : "-";
    const last = s.timestamps.lastMs ? new Date(s.timestamps.lastMs).toISOString() : "-";
    lines.push(
      `- ${s.agentId}/${s.sessionId} sessionKey=${s.sessionKey} -> ${s.entityType}:${s.entityExternalId}`,
    );
    lines.push(
      `  counts: messages=${s.counts.messages} toolCalls=${s.counts.toolCalls} first=${first} last=${last}`,
    );
    if (s.preview && (s.preview.messages.length || s.preview.toolCalls.length)) {
      for (const m of s.preview.messages) {
        lines.push(
          `  msg ${m.role} key=${m.messageKey}${m.occurredAt ? ` at=${m.occurredAt}` : ""}`,
        );
      }
      for (const t of s.preview.toolCalls) {
        lines.push(`  tool ${t.status} ${t.toolName} key=${t.toolCallKey}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

export function coerceSkConfig(params: {
  resolved: {
    baseUrl?: string;
    token?: string;
    authHeader?: string;
    attachPath: string;
    messagesPath: string;
    toolCallsPath: string;
    timeoutMs: number;
    maxTextChars: number;
    maxToolResultChars: number;
    agentsAllowlist?: string[];
  };
  overrides?: Partial<{
    baseUrl: string;
    token: string;
    authHeader: string;
    attachPath: string;
    messagesPath: string;
    toolCallsPath: string;
    timeoutMs: number;
    maxTextChars: number;
    maxToolResultChars: number;
  }>;
}): SkConfig {
  const merged = {
    ...params.resolved,
    ...Object.fromEntries(
      Object.entries(params.overrides ?? {}).filter(([, v]) => v !== undefined && v !== null),
    ),
  };
  const baseUrl = String(merged.baseUrl ?? "").trim();
  if (!baseUrl) {
    throw new Error("Super-Kanban baseUrl is required (set SUPER_KANBAN_BASE_URL or --base-url)");
  }

  return {
    baseUrl,
    token: merged.token,
    authHeader: merged.authHeader,
    attachPath: merged.attachPath,
    messagesPath: merged.messagesPath,
    toolCallsPath: merged.toolCallsPath,
    timeoutMs: merged.timeoutMs,
    maxTextChars: merged.maxTextChars,
    maxToolResultChars: merged.maxToolResultChars,
    agentsAllowlist: merged.agentsAllowlist,
  };
}
