import { describe, expect, it } from "vitest";
import { buildSkMessageKey, buildSkToolCallKey } from "./keys.js";

describe("super-kanban-exporter keys", () => {
  it("uses messageId when present", () => {
    expect(
      buildSkMessageKey({
        sessionKey: "sk_sess",
        messageId: "m1",
        role: "assistant",
        occurredAtMs: 1700000000000,
        content: "hello",
      }),
    ).toBe("sk_sess:m1");
  });

  it("falls back to deterministic hash when messageId missing", () => {
    const a = buildSkMessageKey({
      sessionKey: "sk_sess",
      role: "assistant",
      occurredAtMs: 1700000000000,
      content: "hello",
    });
    const b = buildSkMessageKey({
      sessionKey: "sk_sess",
      role: "assistant",
      occurredAtMs: 1700000000000,
      content: "hello",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^sk_sess:msg:[0-9a-f]{40}$/);
  });

  it("derives toolCallKey from sessionKey + toolCallId", () => {
    expect(buildSkToolCallKey("sk_sess", "tc1")).toBe("sk_sess:tc1");
  });
});
