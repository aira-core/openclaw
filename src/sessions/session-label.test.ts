import { describe, expect, it } from "vitest";
import { makeSkTaskHashLabel, sha256HexPrefix } from "./session-label.js";

describe("session-label", () => {
  it("sha256HexPrefix is deterministic", () => {
    const a = sha256HexPrefix("hello", 16);
    const b = sha256HexPrefix("hello", 16);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("makeSkTaskHashLabel uses sha256(externalId) prefix (16 hex)", () => {
    const externalId = "task:calculator-demo:wi-sk-proof-runner:task_123";
    const expected = `SK:TASKH:${sha256HexPrefix(externalId, 16)}`;
    expect(makeSkTaskHashLabel(externalId)).toBe(expected);
  });
});
