import crypto from "node:crypto";

export function sha1Hex(value: string): string {
  return crypto.createHash("sha1").update(value, "utf8").digest("hex");
}

/**
 * Deterministic, idempotent key for SK message upserts.
 *
 * - If transcript record.id is present, use it for stability.
 * - Otherwise fall back to a sha1 hash derived from role + timestamp + raw content.
 */
export function buildSkMessageKey(params: {
  sessionKey: string;
  messageId?: string;
  role: string;
  occurredAtMs?: number;
  content: string;
}): string {
  const base = params.sessionKey;
  if (params.messageId) {
    return `${base}:${params.messageId}`;
  }
  const h = sha1Hex(`${params.role}|${params.occurredAtMs ?? ""}|${params.content}`);
  return `${base}:msg:${h}`;
}

/** Deterministic, idempotent key for SK tool-call upserts. */
export function buildSkToolCallKey(sessionKey: string, toolCallId: string): string {
  return `${sessionKey}:${toolCallId}`;
}
