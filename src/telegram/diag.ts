import { createHash, randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("telegram/diag");

export function isTelegramDiagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_TELEGRAM_DIAG === "1";
}

export function newTelegramDiagRequestId(): string {
  return randomUUID();
}

export function sha256Hex(value: Buffer | string): string {
  const hash = createHash("sha256");
  if (typeof value === "string") {
    hash.update(value, "utf8");
  } else {
    hash.update(value);
  }
  return hash.digest("hex");
}

function formatKv(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  const keys = Object.keys(meta).toSorted();
  for (const key of keys) {
    const value = meta[key];
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      parts.push(`${key}=null`);
      continue;
    }
    if (typeof value === "string") {
      const safe = value.includes(" ") ? JSON.stringify(value) : value;
      parts.push(`${key}=${safe}`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
      continue;
    }
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return parts.join(" ");
}

export function telegramDiagEvent(event: string, meta: Record<string, unknown>): void {
  if (!isTelegramDiagEnabled()) {
    return;
  }

  const consoleMessage = `${event} ${formatKv(meta)}`.trim();
  log.info(event, { consoleMessage, ...meta });
}
