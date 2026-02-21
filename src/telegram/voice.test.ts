import { describe, expect, it, vi } from "vitest";
import { resolveTelegramVoiceSend } from "./voice.js";

describe("resolveTelegramVoiceSend", () => {
  it("skips voice when wantsVoice is false", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: false,
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it("keeps voice when wantsVoice is true, even for incompatible media", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType: "audio/wav",
      fileName: "track.wav",
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).toHaveBeenCalledWith(
      "Telegram voice requested but media is audio/wav (track.wav); sending as voice anyway.",
    );
  });

  it("keeps voice when compatible", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "audio/mpeg", fileName: "track.mp3" },
    { contentType: "audio/mp4", fileName: "track.m4a" },
  ])("keeps voice for compatible MIME $contentType", ({ contentType, fileName }) => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType,
      fileName,
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });
});
