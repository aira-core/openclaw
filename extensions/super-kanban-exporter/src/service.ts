import fssync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginService } from "openclaw/plugin-sdk";
import type { SuperKanbanExporterConfig } from "./config.js";
import {
  parseSessionFileContext,
  parseTranscriptLineToEvents,
  type SessionFileContext,
  type SuperKanbanMessageRecord,
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

type SpoolEvent =
  | {
      kind: "message";
      sessionId: string;
      agentId?: string;
      topicId?: string;
      payload: SuperKanbanMessageRecord;
    }
  | {
      kind: "toolCall";
      sessionId: string;
      agentId?: string;
      topicId?: string;
      payload: SuperKanbanToolCallRecord;
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
    const safe = truncateText(
      redactTextWithCoreConfig(evt.payload.text, params.coreConfig),
      params.maxTextChars,
    );
    return {
      ...evt,
      payload: { ...evt.payload, text: safe },
    };
  }

  // tool call
  const paramsText = evt.payload.paramsText
    ? truncateText(redactTextWithCoreConfig(evt.payload.paramsText, params.coreConfig), 4000)
    : undefined;
  const resultText = evt.payload.resultText
    ? truncateText(
        redactTextWithCoreConfig(evt.payload.resultText, params.coreConfig),
        params.maxToolResultChars,
      )
    : undefined;
  const errorText = evt.payload.errorText
    ? truncateText(
        redactTextWithCoreConfig(evt.payload.errorText, params.coreConfig),
        params.maxToolResultChars,
      )
    : undefined;

  return {
    ...evt,
    payload: {
      ...evt.payload,
      paramsText,
      resultText,
      errorText,
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

  const buildAttachPayload = (ctx: SessionFileContext) => {
    return {
      source: "openclaw",
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      topicId: ctx.topicId,
      host: os.hostname(),
    };
  };

  const ensureAttached = async (ctx: SessionFileContext, metaPath: string) => {
    if (!meta || !config.baseUrl || !ctx.sessionId) {
      return false;
    }
    const key = keyForSession(ctx.agentId, ctx.sessionId, ctx.topicId);
    if (meta.attachedSessions[key]) {
      return true;
    }
    const url = joinUrl(config.baseUrl, config.attachPath);
    await postJson({
      url,
      payload: buildAttachPayload(ctx),
      headers: resolveAuthHeaders(config),
      timeoutMs: config.timeoutMs,
    });
    meta.attachedSessions[key] = true;
    await writeJsonFile(metaPath, meta);
    return true;
  };

  const sendEvent = async (evt: SpoolEvent, metaPath: string) => {
    if (!config.baseUrl) {
      throw new Error("SUPER_KANBAN_BASE_URL not configured");
    }

    const sessionCtx: SessionFileContext = {
      absPath: "",
      agentId: evt.agentId,
      sessionId: evt.sessionId,
      topicId: evt.topicId,
    };
    await ensureAttached(sessionCtx, metaPath);

    const headers = resolveAuthHeaders(config);

    if (evt.kind === "message") {
      const url = joinUrl(config.baseUrl, config.messagesPath);
      await postJson({ url, payload: evt.payload, headers, timeoutMs: config.timeoutMs });
      return;
    }

    const url = joinUrl(config.baseUrl, config.toolCallsPath);
    await postJson({ url, payload: evt.payload, headers, timeoutMs: config.timeoutMs });
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
        for (const absPath of files) {
          const cursor = meta.fileCursors[absPath]?.offset ?? 0;
          const { lines, nextOffset } = await readAppendedJsonlLines({
            absPath,
            offset: cursor,
            maxLines: 200,
          });
          if (nextOffset !== cursor) {
            meta.fileCursors[absPath] = { offset: nextOffset };
          }
          if (lines.length === 0) {
            continue;
          }
          const fileCtx = parseSessionFileContext(absPath);
          for (const line of lines) {
            const parsed = parseTranscriptLineToEvents({ ctx: fileCtx, line });
            if (!parsed) {
              continue;
            }
            for (const msg of parsed.messages) {
              events.push({
                kind: "message",
                sessionId: msg.sessionId,
                agentId: msg.agentId,
                topicId: msg.topicId,
                payload: msg,
              });
            }
            for (const tool of parsed.toolCalls) {
              events.push({
                kind: "toolCall",
                sessionId: tool.sessionId,
                agentId: tool.agentId,
                topicId: tool.topicId,
                payload: tool,
              });
            }
          }
        }

        if (events.length > 0) {
          enqueueEvents(events, spoolPath, metaPath);
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
      logger.info(`[${pluginId}] stopped`);
    },
  };
}
