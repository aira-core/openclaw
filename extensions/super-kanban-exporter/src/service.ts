import crypto from "node:crypto";
import fssync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginService } from "openclaw/plugin-sdk";
import type { SuperKanbanExporterConfig } from "./config.js";
import {
  parseSessionFileContext,
  parseTranscriptLineToEvents,
  type SessionFileContext,
  type SuperKanbanMessageRecord,
  type SuperKanbanToolCallRecord,
} from "./parser.js";
import { redactSensitiveText, truncateText } from "./redact.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

type ServiceDeps = {
  pluginId: string;
  config: SuperKanbanExporterConfig;
  coreConfig: OpenClawConfig;
  logger: Logger;
};

type MetaFileV1 = {
  version: 1;
  fileCursors: Record<string, { offset: number }>;
  spoolOffset: number;
  attachedSessions: Record<string, true>;
  consecutiveFailures: number;
  nextSendAtMs?: number;
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
  sessionKey: string;
  label: string;
  entityType: ExecutionSessionEntityType;
  entityExternalId: string;
};

type SpoolEvent =
  | {
      kind: "message";
      payload: SkRecordMessageRequest;
    }
  | {
      kind: "toolCall";
      payload: SkRecordToolCallRequest;
    };

const META_VERSION = 1;

function buildPluginDir(stateDir: string, pluginId: string): string {
  return path.join(stateDir, "plugins", pluginId);
}

function keyForSession(agentId: string | undefined, sessionId: string, topicId?: string): string {
  return `${agentId ?? "default"}:${sessionId}${topicId ? `:topic:${topicId}` : ""}`;
}

function resolveAuthHeaders(cfg: SuperKanbanExporterConfig): Record<string, string> {
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

function computeBackoffMs(failureCount: number): number {
  const base = 500;
  const max = 30_000;
  const pow = Math.min(10, Math.max(0, failureCount));
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(max, Math.round(base * Math.pow(2, pow) * jitter));
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildDefaultMeta(): MetaFileV1 {
  return {
    version: META_VERSION,
    fileCursors: {},
    spoolOffset: 0,
    attachedSessions: {},
    consecutiveFailures: 0,
  };
}

async function loadMeta(metaPath: string): Promise<MetaFileV1> {
  const loaded = await readJsonFile<MetaFileV1>(metaPath);
  if (!loaded || loaded.version !== META_VERSION) {
    return buildDefaultMeta();
  }
  return {
    ...buildDefaultMeta(),
    ...loaded,
    fileCursors: loaded.fileCursors ?? {},
    attachedSessions: loaded.attachedSessions ?? {},
  };
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

async function listSessionJsonlFiles(params: {
  stateDir: string;
  agentsAllowlist?: string[];
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
    if (!entry.isDir) {
      continue;
    }
    if (allow && !allow.has(entry.name)) {
      continue;
    }
    const sessionsDir = path.join(agentsDir, entry.name, "sessions");
    let files: string[] = [];
    try {
      files = await fs.readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      // Skip archived/deleted markers.
      if (name.includes(".deleted.") || name.includes(".bak.")) {
        continue;
      }
      out.push(path.join(sessionsDir, name));
    }
  }

  return out;
}

function redactTextWithCoreConfig(text: string, core: OpenClawConfig): string {
  const logging = core.logging;
  const mode = logging?.redactSensitive === "off" ? "off" : "tools";
  const patterns = logging?.redactPatterns;
  return redactSensitiveText(text, { mode, patterns });
}

function normalizeSpoolEvent(
  evt: SpoolEvent,
  params: {
    coreConfig: OpenClawConfig;
    maxTextChars: number;
    maxToolResultChars: number;
  },
): SpoolEvent {
  if (evt.kind === "message") {
    const contentRaw = evt.payload.content;
    const safeContent =
      typeof contentRaw === "string"
        ? truncateText(redactTextWithCoreConfig(contentRaw, params.coreConfig), params.maxTextChars)
        : null;

    return {
      ...evt,
      payload: {
        ...evt.payload,
        content: safeContent,
      },
    };
  }

  // tool call
  const inputJson =
    typeof evt.payload.inputJson === "string"
      ? truncateText(redactTextWithCoreConfig(evt.payload.inputJson, params.coreConfig), 4000)
      : evt.payload.inputJson;

  const outputJson =
    typeof evt.payload.outputJson === "string"
      ? truncateText(
          redactTextWithCoreConfig(evt.payload.outputJson, params.coreConfig),
          params.maxToolResultChars,
        )
      : evt.payload.outputJson;

  const error =
    typeof evt.payload.error === "string"
      ? truncateText(
          redactTextWithCoreConfig(evt.payload.error, params.coreConfig),
          params.maxToolResultChars,
        )
      : evt.payload.error;

  return {
    ...evt,
    payload: {
      ...evt.payload,
      inputJson,
      outputJson,
      error,
    },
  };
}

async function appendSpoolEvents(spoolPath: string, events: SpoolEvent[]): Promise<void> {
  if (events.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(spoolPath), { recursive: true });
  const lines = events.map((e) => `${JSON.stringify(e)}\n`).join("");
  await fs.appendFile(spoolPath, lines, "utf8");
}

async function readNextJsonlLine(params: {
  filePath: string;
  offset: number;
  maxBytes?: number;
}): Promise<{ line: string | null; nextOffset: number }> {
  const stat = await fs.stat(params.filePath);
  if (params.offset >= stat.size) {
    return { line: null, nextOffset: params.offset };
  }

  const fd = await fs.open(params.filePath, "r");
  try {
    const chunkSize = Math.min(64 * 1024, params.maxBytes ?? 64 * 1024);
    const buf = Buffer.alloc(chunkSize);
    let cursor = params.offset;
    let remainder = Buffer.alloc(0);
    while (cursor < stat.size) {
      const startOffset = cursor - remainder.length;
      const { bytesRead } = await fd.read(buf, 0, buf.length, cursor);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buf.subarray(0, bytesRead);
      const combined = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
      const nl = combined.indexOf(0x0a);
      if (nl === -1) {
        // no newline yet; carry remainder and continue
        remainder = combined;
        cursor += bytesRead;
        // guard: avoid unbounded growth
        if (remainder.length > 2 * 1024 * 1024) {
          // Drop huge line; advance to cursor and bail.
          return { line: null, nextOffset: cursor };
        }
        continue;
      }
      const lineBuf = combined.slice(0, nl);
      const nextOffset = startOffset + nl + 1;
      return { line: lineBuf.toString("utf8"), nextOffset };
    }
    return { line: null, nextOffset: cursor };
  } finally {
    await fd.close();
  }
}

async function readAppendedJsonlLines(params: {
  absPath: string;
  offset: number;
  maxLines: number;
}): Promise<{ lines: string[]; nextOffset: number }> {
  const stat = await fs.stat(params.absPath).catch(() => null);
  if (!stat) {
    return { lines: [], nextOffset: params.offset };
  }
  if (params.offset >= stat.size) {
    return { lines: [], nextOffset: params.offset };
  }

  const fd = await fs.open(params.absPath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let cursor = params.offset;
    let remainder = Buffer.alloc(0);
    let advanced = 0;
    const lines: string[] = [];

    while (cursor < stat.size && lines.length < params.maxLines) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, cursor);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buf.subarray(0, bytesRead);
      const combined = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;

      let start = 0;
      while (lines.length < params.maxLines) {
        const nl = combined.indexOf(0x0a, start);
        if (nl === -1) {
          break;
        }
        const lineBuf = combined.slice(start, nl);
        const line = lineBuf.toString("utf8");
        if (line.trim()) {
          lines.push(line);
        }
        start = nl + 1;
      }

      const consumed = start;
      remainder = combined.slice(consumed);
      advanced += consumed;
      cursor += bytesRead;

      if (remainder.length > 2 * 1024 * 1024) {
        // Give up on extremely long lines; advance and drop remainder.
        remainder = Buffer.alloc(0);
      }
    }

    return { lines, nextOffset: params.offset + advanced };
  } finally {
    await fd.close();
  }
}

export function createSuperKanbanExporterService(deps: ServiceDeps): OpenClawPluginService {
  const { pluginId, config, coreConfig, logger } = deps;

  let stopped = false;
  let tailInterval: ReturnType<typeof setInterval> | null = null;
  let sendInterval: ReturnType<typeof setInterval> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  let meta: MetaFileV1 | null = null;
  // Used for resolving legacy spool events (sessionId -> sessionKey/label).
  let stateDirForResolve: string | null = null;
  const pending: SpoolEvent[] = [];

  const pluginDir = (ctxStateDir: string) => buildPluginDir(ctxStateDir, pluginId);

  const maybeFlush = async (spoolPath: string, metaPath: string) => {
    if (pending.length === 0) {
      return;
    }
    const batch = pending.splice(0, pending.length);
    await appendSpoolEvents(spoolPath, batch);
    if (meta) {
      await writeJsonFile(metaPath, meta);
    }
  };

  const scheduleFlush = (spoolPath: string, metaPath: string) => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      maybeFlush(spoolPath, metaPath).catch((err) => {
        logger.warn(`[${pluginId}] failed flushing spool: ${String(err)}`);
      });
    }, config.debounceMs);
    flushTimer.unref?.();
  };

  const enqueueEvents = (events: SpoolEvent[], spoolPath: string, metaPath: string) => {
    if (!meta) {
      return;
    }
    for (const evt of events) {
      pending.push(
        normalizeSpoolEvent(evt, {
          coreConfig,
          maxTextChars: config.maxTextChars,
          maxToolResultChars: config.maxToolResultChars,
        }),
      );
    }
    scheduleFlush(spoolPath, metaPath);
  };

  const ensureAttached = async (
    params: {
      sessionKey: string;
      entityType: ExecutionSessionEntityType;
      entityId?: string;
      entityExternalId?: string;
      startedAt?: string | null;
    },
    metaPath: string,
  ) => {
    if (!meta || !config.baseUrl) {
      return false;
    }

    if (!params.sessionKey) {
      return false;
    }

    // Prefer tracking by sessionKey (unique across agent sessions).
    const attachedKey = params.sessionKey;
    if (meta.attachedSessions[attachedKey]) {
      return true;
    }

    const payload: SkAttachSessionRequest = {
      entityType: params.entityType,
      entityId: params.entityId,
      entityExternalId: params.entityExternalId,
      sessionKey: params.sessionKey,
      state: "RUNNING",
      startedAt: params.startedAt ?? null,
    };

    if (!payload.entityId && !payload.entityExternalId) {
      return false;
    }

    const url = joinUrl(config.baseUrl, config.attachPath);
    await postJson({
      url,
      payload,
      headers: resolveAuthHeaders(config),
      timeoutMs: config.timeoutMs,
    });

    meta.attachedSessions[attachedKey] = true;
    await writeJsonFile(metaPath, meta);
    return true;
  };

  // --- Session binding (sessionId -> sessionKey + entity routing via session label)
  // sessions.json shape: { [sessionKey]: { sessionId, label?, runId?, jobId?, ... } }
  const sessionsIndexCache = new Map<
    string,
    { mtimeMs: number; bySessionId: Map<string, { sessionKey: string; label?: string }> }
  >();

  const sessionsIndexCacheKey = (agentId: string) => `${agentId}`;

  const parseEntityFromSessionLabel = (
    label: string,
  ): {
    entityType: ExecutionSessionEntityType;
    entityExternalId: string;
  } | null => {
    const raw = String(label || "").trim();
    if (!raw) return null;

    const m = /^SK:(PROJECT|WORK_ITEM|TASK):(.*)$/.exec(raw);
    if (!m) return null;

    const entityType = m[1] as ExecutionSessionEntityType;
    const entityExternalId = (m[2] || "").trim();
    if (!entityExternalId) return null;

    return { entityType, entityExternalId };
  };

  const loadAgentSessionsIndex = async (stateDir: string, agentId: string) => {
    const cacheKey = sessionsIndexCacheKey(agentId);
    const sessionsPath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
    const stat = await fs.stat(sessionsPath).catch(() => null);
    if (!stat) {
      sessionsIndexCache.delete(cacheKey);
      return null;
    }

    const cached = sessionsIndexCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }

    const raw = await fs.readFile(sessionsPath, "utf8").catch(() => "");
    if (!raw.trim()) {
      sessionsIndexCache.delete(cacheKey);
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
      // If there are duplicates, keep the first one.
      if (!bySessionId.has(sessionId)) {
        bySessionId.set(sessionId, { sessionKey, label });
      }
    }

    const record = { mtimeMs: stat.mtimeMs, bySessionId };
    sessionsIndexCache.set(cacheKey, record);
    return record;
  };

  const resolveSessionBinding = async (params: {
    stateDir: string;
    agentId?: string;
    sessionId?: string;
  }): Promise<SessionBinding | null> => {
    if (!params.agentId || !params.sessionId) {
      return null;
    }

    const idx = await loadAgentSessionsIndex(params.stateDir, params.agentId);
    const info = idx?.bySessionId.get(params.sessionId);
    if (!info?.sessionKey) {
      return null;
    }

    const label = info.label ?? "";
    const entity = parseEntityFromSessionLabel(label);
    if (!entity) {
      return null;
    }

    return {
      sessionKey: info.sessionKey,
      label,
      entityType: entity.entityType,
      entityExternalId: entity.entityExternalId,
    };
  };

  const sha1Hex = (value: string) => crypto.createHash("sha1").update(value, "utf8").digest("hex");

  const toIsoOrNull = (tsMs: number | undefined): string | null => {
    if (!tsMs || !Number.isFinite(tsMs)) {
      return null;
    }
    return new Date(tsMs).toISOString();
  };

  const normalizeSkRole = (role: string): SkMessageRole | null => {
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
  };

  const buildMessageKey = (params: {
    sessionKey: string;
    messageId?: string;
    role: string;
    occurredAtMs?: number;
    content: string;
  }) => {
    const base = params.sessionKey;
    if (params.messageId) {
      return `${base}:${params.messageId}`;
    }
    const h = sha1Hex(`${params.role}|${params.occurredAtMs ?? ""}|${params.content}`);
    return `${base}:msg:${h}`;
  };

  const buildToolCallKey = (sessionKey: string, toolCallId: string) =>
    `${sessionKey}:${toolCallId}`;

  const sendEvent = async (evt: any, metaPath: string): Promise<"sent" | "skipped"> => {
    if (!config.baseUrl) {
      throw new Error("SUPER_KANBAN_BASE_URL not configured");
    }

    const headers = resolveAuthHeaders(config);

    const ensureAttachedForPayload = async (payload: {
      sessionKey: string;
      entityType: ExecutionSessionEntityType;
      entityId?: string;
      entityExternalId?: string;
      startedAt?: string | null;
      endedAt?: string | null;
      occurredAt?: string | null;
    }) => {
      const startedAt = payload.occurredAt ?? payload.startedAt ?? payload.endedAt ?? null;
      await ensureAttached(
        {
          sessionKey: payload.sessionKey,
          entityType: payload.entityType,
          entityId: payload.entityId,
          entityExternalId: payload.entityExternalId,
          startedAt,
        },
        metaPath,
      );
    };

    if (evt?.kind === "message") {
      const payload = evt?.payload;

      // New spool format (already matches SK OpenAPI).
      if (
        payload &&
        typeof payload.sessionKey === "string" &&
        typeof payload.entityType === "string" &&
        typeof payload.messageKey === "string"
      ) {
        await ensureAttachedForPayload(payload as SkRecordMessageRequest);
        const url = joinUrl(config.baseUrl, config.messagesPath);
        await postJson({ url, payload, headers, timeoutMs: config.timeoutMs });
        return "sent";
      }

      // Legacy spool format: attempt best-effort upgrade; otherwise skip.
      if (!stateDirForResolve) {
        return "skipped";
      }

      const legacy = payload as SuperKanbanMessageRecord | undefined;
      const agentId = evt.agentId ?? legacy?.agentId;
      const sessionId = evt.sessionId ?? legacy?.sessionId;
      const topicId = evt.topicId ?? legacy?.topicId;

      const binding = await resolveSessionBinding({
        stateDir: stateDirForResolve,
        agentId,
        sessionId,
      });
      if (!binding) {
        return "skipped";
      }

      const role = normalizeSkRole(String(legacy?.role ?? "")) ?? "assistant";
      const content = typeof legacy?.text === "string" ? legacy.text : "";
      if (!content.trim()) {
        return "skipped";
      }

      const occurredAtMs = typeof legacy?.timestamp === "number" ? legacy.timestamp : undefined;
      const occurredAt = toIsoOrNull(occurredAtMs);

      const upgraded: SkRecordMessageRequest = {
        sessionKey: binding.sessionKey,
        entityType: binding.entityType,
        entityExternalId: binding.entityExternalId,
        messageKey: buildMessageKey({
          sessionKey: binding.sessionKey,
          messageId: legacy?.messageId,
          role,
          occurredAtMs,
          content,
        }),
        role,
        content,
        occurredAt,
        metadata: {
          agentId: agentId ?? null,
          sessionId: sessionId ?? null,
          topicId: topicId ?? null,
          label: binding.label,
          legacy: true,
        },
      };

      await ensureAttachedForPayload(upgraded);
      const url = joinUrl(config.baseUrl, config.messagesPath);
      await postJson({ url, payload: upgraded, headers, timeoutMs: config.timeoutMs });
      return "sent";
    }

    if (evt?.kind === "toolCall") {
      const payload = evt?.payload;

      // New spool format.
      if (
        payload &&
        typeof payload.sessionKey === "string" &&
        typeof payload.entityType === "string" &&
        typeof payload.toolCallKey === "string"
      ) {
        await ensureAttachedForPayload(payload as SkRecordToolCallRequest);
        const url = joinUrl(config.baseUrl, config.toolCallsPath);
        await postJson({ url, payload, headers, timeoutMs: config.timeoutMs });
        return "sent";
      }

      // Legacy spool format.
      if (!stateDirForResolve) {
        return "skipped";
      }

      const legacy = payload as SuperKanbanToolCallRecord | undefined;
      const agentId = evt.agentId ?? legacy?.agentId;
      const sessionId = evt.sessionId ?? legacy?.sessionId;
      const topicId = evt.topicId ?? legacy?.topicId;

      const binding = await resolveSessionBinding({
        stateDir: stateDirForResolve,
        agentId,
        sessionId,
      });
      if (!binding || !legacy?.toolCallId) {
        return "skipped";
      }

      const tsMs = typeof legacy.timestamp === "number" ? legacy.timestamp : undefined;
      const tsIso = toIsoOrNull(tsMs);
      const startedAt = legacy.status === "STARTED" ? tsIso : null;
      const endedAt = legacy.status === "SUCCEEDED" || legacy.status === "FAILED" ? tsIso : null;

      const upgraded: SkRecordToolCallRequest = {
        sessionKey: binding.sessionKey,
        entityType: binding.entityType,
        entityExternalId: binding.entityExternalId,
        toolCallKey: buildToolCallKey(binding.sessionKey, legacy.toolCallId),
        toolName: legacy.toolName?.trim() || "unknown",
        status: legacy.status,
        startedAt,
        endedAt,
        inputJson: legacy.paramsText ?? undefined,
        outputJson: legacy.resultText ?? undefined,
        error: legacy.errorText ?? null,
      };

      await ensureAttachedForPayload(upgraded);
      const url = joinUrl(config.baseUrl, config.toolCallsPath);
      await postJson({ url, payload: upgraded, headers, timeoutMs: config.timeoutMs });
      return "sent";
    }

    return "skipped";
  };

  const processSpool = async (spoolPath: string, metaPath: string) => {
    if (!meta || stopped) {
      return;
    }
    const nextSendAt = meta.nextSendAtMs ?? 0;
    if (Date.now() < nextSendAt) {
      return;
    }

    if (!fssync.existsSync(spoolPath)) {
      return;
    }

    // Drain a few events per tick to keep latency low.
    const maxPerTick = 50;
    for (let i = 0; i < maxPerTick; i += 1) {
      const { line, nextOffset } = await readNextJsonlLine({
        filePath: spoolPath,
        offset: meta.spoolOffset,
      });
      if (!line) {
        // Optional truncate when fully drained.
        const stat = await fs.stat(spoolPath).catch(() => null);
        if (stat && meta.spoolOffset >= stat.size && stat.size > 0) {
          await fs.writeFile(spoolPath, "", "utf8");
          meta.spoolOffset = 0;
          await writeJsonFile(metaPath, meta);
        }
        return;
      }

      let evt: SpoolEvent;
      try {
        evt = JSON.parse(line) as SpoolEvent;
      } catch {
        meta.spoolOffset = nextOffset;
        continue;
      }

      try {
        await sendEvent(evt, metaPath);
        meta.spoolOffset = nextOffset;
        meta.consecutiveFailures = 0;
        meta.nextSendAtMs = undefined;
        await writeJsonFile(metaPath, meta);
      } catch (err) {
        meta.consecutiveFailures = (meta.consecutiveFailures ?? 0) + 1;
        const delay = computeBackoffMs(meta.consecutiveFailures);
        meta.nextSendAtMs = Date.now() + delay;
        await writeJsonFile(metaPath, meta);
        logger.warn(
          `[${pluginId}] send failed (will retry in ${delay}ms): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }
  };

  // (tailer is defined inside start() where ctx.stateDir is available)

  return {
    id: pluginId,
    async start(ctx) {
      if (!config.enabled) {
        return;
      }
      if (!config.baseUrl) {
        logger.warn(`[${pluginId}] enabled but missing baseUrl; set SUPER_KANBAN_BASE_URL`);
        return;
      }
      if (!config.token && !config.authHeader) {
        logger.warn(`[${pluginId}] enabled but missing token/authHeader; requests may be rejected`);
      }

      const dir = pluginDir(ctx.stateDir);
      const metaPath = path.join(dir, "meta.json");
      const spoolPath = path.join(dir, "spool.jsonl");

      meta = await loadMeta(metaPath);
      stateDirForResolve = ctx.stateDir;
      await fs.mkdir(dir, { recursive: true });

      logger.info(
        `[${pluginId}] started (poll=${config.pollIntervalMs}ms, debounce=${config.debounceMs}ms, baseUrl=${config.baseUrl})`,
      );

      const scanAndEnqueue = async () => {
        if (!meta || stopped) {
          return;
        }
        const files = await listSessionJsonlFiles({
          stateDir: ctx.stateDir,
          agentsAllowlist: config.agentsAllowlist,
        });

        const events: SpoolEvent[] = [];
        let cursorChanged = false;
        for (const absPath of files) {
          const existingCursor = meta.fileCursors[absPath];
          if (!existingCursor && !config.backfillExistingSessions) {
            const stat = await fs.stat(absPath).catch(() => null);
            if (stat) {
              meta.fileCursors[absPath] = { offset: stat.size };
              cursorChanged = true;
              continue;
            }
          }

          const cursor = existingCursor?.offset ?? 0;
          const { lines, nextOffset } = await readAppendedJsonlLines({
            absPath,
            offset: cursor,
            maxLines: 200,
          });
          if (nextOffset !== cursor) {
            meta.fileCursors[absPath] = { offset: nextOffset };
            cursorChanged = true;
          }
          if (lines.length === 0) {
            continue;
          }
          const fileCtx = parseSessionFileContext(absPath);

          const binding = await resolveSessionBinding({
            stateDir: ctx.stateDir,
            agentId: fileCtx.agentId,
            sessionId: fileCtx.sessionId,
          });

          // Only export sessions explicitly labeled with an SK routing label.
          if (!binding) {
            continue;
          }

          for (const line of lines) {
            const parsed = parseTranscriptLineToEvents({ ctx: fileCtx, line });
            if (!parsed) {
              continue;
            }

            for (const msg of parsed.messages) {
              const role = normalizeSkRole(msg.role);
              if (!role) {
                continue;
              }

              const occurredAt = toIsoOrNull(msg.timestamp);
              const messageKey = buildMessageKey({
                sessionKey: binding.sessionKey,
                messageId: msg.messageId,
                role,
                occurredAtMs: msg.timestamp,
                content: msg.text,
              });

              const payload: SkRecordMessageRequest = {
                sessionKey: binding.sessionKey,
                entityType: binding.entityType,
                entityExternalId: binding.entityExternalId,
                messageKey,
                role,
                content: msg.text,
                occurredAt,
                metadata: {
                  agentId: msg.agentId ?? null,
                  sessionId: msg.sessionId,
                  topicId: msg.topicId ?? null,
                  messageId: msg.messageId ?? null,
                  label: binding.label,
                },
              };

              events.push({ kind: "message", payload });
            }

            for (const tool of parsed.toolCalls) {
              if (!tool.toolCallId) {
                continue;
              }

              const tsIso = toIsoOrNull(tool.timestamp);
              const startedAt = tool.status === "STARTED" ? tsIso : null;
              const endedAt =
                tool.status === "SUCCEEDED" || tool.status === "FAILED" ? tsIso : null;

              const payload: SkRecordToolCallRequest = {
                sessionKey: binding.sessionKey,
                entityType: binding.entityType,
                entityExternalId: binding.entityExternalId,
                toolCallKey: buildToolCallKey(binding.sessionKey, tool.toolCallId),
                toolName: tool.toolName?.trim() || "unknown",
                status: tool.status,
                startedAt,
                endedAt,
                inputJson: tool.paramsText ?? undefined,
                outputJson: tool.resultText ?? undefined,
                error: tool.errorText ?? null,
              };

              events.push({ kind: "toolCall", payload });
            }
          }
        }

        if (events.length > 0) {
          enqueueEvents(events, spoolPath, metaPath);
          return;
        }

        if (cursorChanged) {
          await writeJsonFile(metaPath, meta);
        }
      };

      // Best-effort initial scan.
      await scanAndEnqueue().catch((err) => {
        logger.warn(`[${pluginId}] initial scan failed: ${String(err)}`);
      });

      tailInterval = setInterval(() => {
        scanAndEnqueue().catch((err) => {
          logger.warn(`[${pluginId}] tail scan failed: ${String(err)}`);
        });
      }, config.pollIntervalMs);
      tailInterval.unref?.();

      sendInterval = setInterval(() => {
        // flush pending events to spool first
        maybeFlush(spoolPath, metaPath)
          .then(() => processSpool(spoolPath, metaPath))
          .catch((err) => {
            logger.warn(`[${pluginId}] sender tick failed: ${String(err)}`);
          });
      }, 250);
      sendInterval.unref?.();
    },
    async stop(ctx) {
      stopped = true;
      if (tailInterval) {
        clearInterval(tailInterval);
        tailInterval = null;
      }
      if (sendInterval) {
        clearInterval(sendInterval);
        sendInterval = null;
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      const dir = pluginDir(ctx.stateDir);
      const metaPath = path.join(dir, "meta.json");
      const spoolPath = path.join(dir, "spool.jsonl");

      await maybeFlush(spoolPath, metaPath).catch(() => {});
      if (meta) {
        await writeJsonFile(metaPath, meta).catch(() => {});
      }
      meta = null;
      stateDirForResolve = null;
      logger.info(`[${pluginId}] stopped`);
    },
  };
}
