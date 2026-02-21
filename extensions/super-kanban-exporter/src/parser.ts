import path from "node:path";

export type SessionFileContext = {
  absPath: string;
  agentId?: string;
  sessionId?: string;
  topicId?: string;
};

export type TranscriptRecord = {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
};

export type TranscriptMessage = {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
};

export type SuperKanbanMessageRecord = {
  sessionId: string;
  agentId?: string;
  topicId?: string;
  messageId?: string;
  timestamp?: number;
  role: string;
  text: string;
};

export type SuperKanbanToolCallStatus = "STARTED" | "SUCCEEDED" | "FAILED";

export type SuperKanbanToolCallRecord = {
  sessionId: string;
  agentId?: string;
  topicId?: string;
  messageId?: string;
  toolCallId: string;
  toolName?: string;
  status: SuperKanbanToolCallStatus;
  timestamp?: number;
  durationMs?: number;
  paramsText?: string;
  resultText?: string;
  errorText?: string;
};

export type ParsedTranscriptEvents = {
  attach: { sessionId: string; agentId?: string; topicId?: string };
  messages: SuperKanbanMessageRecord[];
  toolCalls: SuperKanbanToolCallRecord[];
};

const TOOL_CALL_TYPES = new Set(["toolcall", "tool_call", "tool_use"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "tool_result_error", "toolresult"]);

function normalizeType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeTypeLower(value: unknown): string {
  return normalizeType(value).toLowerCase();
}

export function parseSessionFileContext(absPath: string): SessionFileContext {
  const normalized = path.resolve(absPath);
  const base = path.basename(normalized);
  const fileBase = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;

  // sessionId[-topic-<topicId>]
  let sessionId = fileBase;
  let topicId: string | undefined;
  const topicIdx = fileBase.indexOf("-topic-");
  if (topicIdx !== -1) {
    sessionId = fileBase.slice(0, topicIdx);
    const rawTopic = fileBase.slice(topicIdx + "-topic-".length);
    try {
      topicId = decodeURIComponent(rawTopic);
    } catch {
      topicId = rawTopic;
    }
  }

  // .../agents/<agentId>/sessions/<file>
  let agentId: string | undefined;
  const parts = normalized.split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex >= 2 && parts[sessionsIndex - 2] === "agents") {
    agentId = parts[sessionsIndex - 1];
  }

  return { absPath: normalized, agentId, sessionId, topicId };
}

export function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const type = normalizeTypeLower(block.type);
    if (type === "text" && typeof block.text === "string") {
      const trimmed = block.text.trim();
      if (trimmed) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function coerceTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // already ms
    return value;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) {
      return t;
    }
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildToolCallId(
  fallbackPrefix: string,
  block: Record<string, unknown>,
  idx: number,
): string {
  const id = coerceString(block.id ?? block.toolCallId ?? block.tool_call_id);
  if (id) {
    return id;
  }
  return `${fallbackPrefix}:${idx}`;
}

export function parseTranscriptLineToEvents(params: {
  ctx: SessionFileContext;
  line: string;
  maxTextChars?: number;
}): ParsedTranscriptEvents | null {
  const sessionId = params.ctx.sessionId;
  if (!sessionId) {
    return null;
  }

  let record: TranscriptRecord;
  try {
    record = JSON.parse(params.line) as TranscriptRecord;
  } catch {
    return null;
  }

  if (record?.type !== "message") {
    return null;
  }

  const msg = (record.message ?? null) as TranscriptMessage | null;
  if (!msg || typeof msg !== "object") {
    return null;
  }

  const role = normalizeRole(msg.role);
  const messageId = coerceString(record.id);
  const timestamp = coerceTimestampMs(record.timestamp);

  const attach = { sessionId, agentId: params.ctx.agentId, topicId: params.ctx.topicId };

  const messages: SuperKanbanMessageRecord[] = [];
  const toolCalls: SuperKanbanToolCallRecord[] = [];

  // 1) User/assistant messages (text only)
  if (role === "user" || role === "assistant") {
    const texts = extractTextBlocks(msg.content);
    const text = texts.join("\n").trim();
    if (text) {
      messages.push({
        sessionId,
        agentId: params.ctx.agentId,
        topicId: params.ctx.topicId,
        messageId,
        timestamp,
        role,
        text,
      });
    }

    // 2) Tool call STARTED events from assistant content blocks
    if (role === "assistant" && Array.isArray(msg.content)) {
      const fallbackPrefix = messageId ?? `${sessionId}:${timestamp ?? ""}`;
      for (let idx = 0; idx < msg.content.length; idx += 1) {
        const entry = msg.content[idx];
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const block = entry as Record<string, unknown>;
        const typeLower = normalizeTypeLower(block.type);
        const typeRaw = normalizeType(block.type);
        if (!TOOL_CALL_TYPES.has(typeLower) && !TOOL_CALL_TYPES.has(typeRaw.toLowerCase())) {
          continue;
        }
        const toolCallId = buildToolCallId(fallbackPrefix, block, idx);
        const toolName = coerceString(block.name ?? block.toolName ?? block.tool_name);
        const argsRaw =
          block.arguments ??
          (block as any).args ??
          (block as any).params ??
          (block as any).input ??
          undefined;
        const paramsText =
          typeof argsRaw === "string"
            ? argsRaw
            : argsRaw !== undefined
              ? safeJsonStringify(argsRaw)
              : undefined;

        toolCalls.push({
          sessionId,
          agentId: params.ctx.agentId,
          topicId: params.ctx.topicId,
          messageId,
          toolCallId,
          toolName,
          status: "STARTED",
          timestamp,
          paramsText,
        });
      }
    }

    // 3) Tool result blocks embedded in assistant content (compat)
    if (role === "assistant" && Array.isArray(msg.content)) {
      const fallbackPrefix = messageId ?? `${sessionId}:${timestamp ?? ""}`;
      for (let idx = 0; idx < msg.content.length; idx += 1) {
        const entry = msg.content[idx];
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const block = entry as Record<string, unknown>;
        const typeLower = normalizeTypeLower(block.type);
        const typeRaw = normalizeType(block.type);
        if (!TOOL_RESULT_TYPES.has(typeLower) && !TOOL_RESULT_TYPES.has(typeRaw.toLowerCase())) {
          continue;
        }
        const toolCallId = buildToolCallId(fallbackPrefix, block, idx);
        const toolName = coerceString(block.name ?? block.toolName ?? block.tool_name);
        const isError = block.is_error === true || block.isError === true;
        const content = coerceString(block.content) ?? coerceString(block.text);
        toolCalls.push({
          sessionId,
          agentId: params.ctx.agentId,
          topicId: params.ctx.topicId,
          messageId,
          toolCallId,
          toolName,
          status: isError ? "FAILED" : "SUCCEEDED",
          timestamp,
          resultText: content,
          errorText: isError ? content : undefined,
        });
      }
    }

    return { attach, messages, toolCalls };
  }

  // 4) ToolResult role (per Orion) - also treated as a tool call completion event
  if (role === "toolResult" || role === "tool_result") {
    const toolCallId = coerceString(msg.toolCallId) ?? coerceString((msg as any).tool_call_id);
    if (!toolCallId) {
      return { attach, messages, toolCalls };
    }
    const toolName = coerceString(msg.toolName) ?? coerceString((msg as any).tool_name);
    const isError = msg.isError === true || (msg as any).is_error === true;
    const texts = extractTextBlocks(msg.content);
    const content = texts.join("\n").trim();

    toolCalls.push({
      sessionId,
      agentId: params.ctx.agentId,
      topicId: params.ctx.topicId,
      messageId,
      toolCallId,
      toolName,
      status: isError ? "FAILED" : "SUCCEEDED",
      timestamp,
      resultText: content,
      errorText: isError ? content : undefined,
    });

    // Optional: also record it as a message (still useful for debugging)
    if (content) {
      messages.push({
        sessionId,
        agentId: params.ctx.agentId,
        topicId: params.ctx.topicId,
        messageId,
        timestamp,
        role,
        text: content,
      });
    }

    return { attach, messages, toolCalls };
  }

  return { attach, messages, toolCalls };
}
