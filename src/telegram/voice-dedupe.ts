import { createSubsystemLogger } from "../logging/subsystem.js";
import { sha256Hex, telegramDiagEvent } from "./diag.js";

export function isTelegramVoiceDedupeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_TELEGRAM_DEDUP_VOICE === "1";
}

type VoiceDedupeEntry = {
  ts: number;
};

type VoiceDedupeChatState = {
  /** LRU of fingerprints -> timestamp */
  lru: Map<string, VoiceDedupeEntry>;
};

const DEFAULT_WINDOW_MS = 10_000;
const MAX_CHATS = 500;
const MAX_FINGERPRINTS_PER_CHAT = 50;

// accountId/chatId -> per-chat LRU cache
const voiceDedupeByChat = new Map<string, VoiceDedupeChatState>();

function touchChat(key: string, state: VoiceDedupeChatState) {
  // Refresh insertion order for chat-level LRU.
  voiceDedupeByChat.delete(key);
  voiceDedupeByChat.set(key, state);

  while (voiceDedupeByChat.size > MAX_CHATS) {
    const oldestKey = voiceDedupeByChat.keys().next().value;
    if (!oldestKey) {
      break;
    }
    voiceDedupeByChat.delete(oldestKey);
  }
}

function touchFingerprint(state: VoiceDedupeChatState, fp: string, ts: number) {
  state.lru.delete(fp);
  state.lru.set(fp, { ts });

  while (state.lru.size > MAX_FINGERPRINTS_PER_CHAT) {
    const oldestFp = state.lru.keys().next().value;
    if (!oldestFp) {
      break;
    }
    state.lru.delete(oldestFp);
  }
}

function pruneExpired(state: VoiceDedupeChatState, now: number, windowMs: number) {
  // Map is insertion-ordered; stop when we hit a recent entry.
  for (const [fp, entry] of state.lru) {
    if (now - entry.ts <= windowMs) {
      break;
    }
    state.lru.delete(fp);
  }
}

export function shouldDedupeTelegramVoiceSend(params: {
  accountId: string;
  chatId: string;
  fingerprint: string;
  now?: number;
  windowMs?: number;
}): boolean {
  const now = params.now ?? Date.now();
  const windowMs = params.windowMs ?? DEFAULT_WINDOW_MS;
  const chatKey = `${params.accountId}:${params.chatId}`;
  let state = voiceDedupeByChat.get(chatKey);
  if (!state) {
    state = { lru: new Map() };
    voiceDedupeByChat.set(chatKey, state);
  }

  touchChat(chatKey, state);
  pruneExpired(state, now, windowMs);

  const existing = state.lru.get(params.fingerprint);
  if (existing && now - existing.ts <= windowMs) {
    // Refresh LRU so repeated duplicates don't keep an old entry at the head.
    touchFingerprint(state, params.fingerprint, existing.ts);
    return true;
  }

  touchFingerprint(state, params.fingerprint, now);
  return false;
}

export function computeTelegramVoiceFingerprint(buffer: Buffer | Uint8Array): string {
  // sha256 is stable and already used by existing telegram diagnostic logs.
  return sha256Hex(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

const dedupeLog = createSubsystemLogger("telegram/dedupe");

export function logTelegramVoiceDedupe(params: {
  accountId?: string;
  chatId?: string;
  fingerprint?: string;
  windowMs?: number;
  deliveryId?: string;
  operation?: string;
}): void {
  // Always log dedupes (flag-gated by OPENCLAW_TELEGRAM_DEDUP_VOICE).
  dedupeLog.warn("telegram voice send deduped", {
    accountId: params.accountId,
    chatId: params.chatId,
    fingerprint: params.fingerprint,
    windowMs: params.windowMs ?? DEFAULT_WINDOW_MS,
    deliveryId: params.deliveryId,
    operation: params.operation,
  });

  // Also emit as a structured diagnostic event when OPENCLAW_TELEGRAM_DIAG=1.
  telegramDiagEvent("telegram.sendVoice.deduped", {
    accountId: params.accountId,
    chatId: params.chatId,
    fingerprint: params.fingerprint,
    windowMs: params.windowMs ?? DEFAULT_WINDOW_MS,
    deliveryId: params.deliveryId,
    operation: params.operation,
  });
}

export function resetTelegramVoiceDedupeForTests(): void {
  voiceDedupeByChat.clear();
}
