import crypto from "node:crypto";

export const SESSION_LABEL_MAX_LENGTH = 64;

export type ParsedSessionLabel = { ok: true; label: string } | { ok: false; error: string };

export function parseSessionLabel(raw: unknown): ParsedSessionLabel {
  if (typeof raw !== "string") {
    return { ok: false, error: "invalid label: must be a string" };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "invalid label: empty" };
  }
  if (trimmed.length > SESSION_LABEL_MAX_LENGTH) {
    return {
      ok: false,
      error: `invalid label: too long (max ${SESSION_LABEL_MAX_LENGTH})`,
    };
  }
  return { ok: true, label: trimmed };
}

export function sha256HexPrefix(value: string, hexLen: number): string {
  const n = Math.max(1, Math.floor(hexLen));
  return crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex")
    .slice(0, n);
}

/**
 * Stable, short label for Super-Kanban task routing when the externalId is too long to embed.
 *
 * Format: SK:TASKH:<sha256(externalId)[0:16]>
 */
export function makeSkTaskHashLabel(externalId: string): string {
  return `SK:TASKH:${sha256HexPrefix(externalId, 16)}`;
}

/**
 * Deterministically truncates a label to fit within SESSION_LABEL_MAX_LENGTH.
 *
 * Format: <prefix><~hash>
 *
 * - Hash is sha256(label) truncated to 10 hex chars.
 * - The output always ends with the same suffix for the same input.
 *
 * This is useful for integrations that need stable labels (e.g. SK:TASK:<externalId>)
 * without risking validation failures due to length.
 */
export function truncateSessionLabelWithHash(
  label: string,
  maxLen: number = SESSION_LABEL_MAX_LENGTH,
): string {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxLen) {
    return trimmed;
  }

  const hash = crypto.createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 10);
  const suffix = `~${hash}`;

  if (suffix.length >= maxLen) {
    return suffix.slice(0, maxLen);
  }

  const headLen = maxLen - suffix.length;
  return `${trimmed.slice(0, headLen)}${suffix}`;
}
