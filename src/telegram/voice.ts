import { isTelegramVoiceCompatibleAudio } from "../media/audio.js";

export function resolveTelegramVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
}): { useVoice: boolean; forced?: boolean; reason?: string } {
  if (!opts.wantsVoice) {
    return { useVoice: false };
  }

  if (isTelegramVoiceCompatibleAudio(opts)) {
    return { useVoice: true };
  }

  // When the caller explicitly asks for a voice note ("voice bubble"), do not
  // silently fall back to sendAudio. Doing so can lead to duplicates when another
  // delivery path later retries as sendVoice for the same payload.
  const contentType = opts.contentType ?? "unknown";
  const fileName = opts.fileName ?? "unknown";
  return {
    useVoice: true,
    forced: true,
    reason: `media is ${contentType} (${fileName})`,
  };
}

export function resolveTelegramVoiceSend(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
  logFallback?: (message: string) => void;
}): { useVoice: boolean } {
  const decision = resolveTelegramVoiceDecision(opts);
  if (decision.forced && decision.reason && opts.logFallback) {
    opts.logFallback(`Telegram voice requested but ${decision.reason}; sending as voice anyway.`);
  }
  return { useVoice: decision.useVoice };
}
