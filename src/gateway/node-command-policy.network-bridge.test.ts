import { describe, expect, it } from "vitest";
import { resolveNodeCommandAllowlist } from "./node-command-policy.js";

describe("node bridge command allowlist", () => {
  it("includes Android network bridge commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "android 16",
        deviceFamily: "Android",
      },
    );

    expect(allow.has("network.bridge.open")).toBe(true);
    expect(allow.has("network.bridge.write")).toBe(true);
    expect(allow.has("network.bridge.read")).toBe(true);
    expect(allow.has("network.bridge.close")).toBe(true);
  });
});
