import { describe, expect, it, vi } from "vitest";
import { createWakeParentOnEndTracker, resolveWakeParentOnEnd } from "./index.js";

describe("sk-sync wakeParentOnEnd", () => {
  it("defaults wakeParentOnEnd to true (opt-out with false)", () => {
    expect(resolveWakeParentOnEnd(undefined)).toBe(true);
    expect(resolveWakeParentOnEnd(true)).toBe(true);
    expect(resolveWakeParentOnEnd(false)).toBe(false);
  });

  it("calls wakeParent (gateway agent RPC) once on subagent end when enabled (explicit true)", async () => {
    const logger = { warn: vi.fn() };
    const wakeParent = vi.fn(async (_params: Record<string, unknown>) => ({ status: "ok" }));

    const tracker = createWakeParentOnEndTracker({ logger, wakeParent });

    tracker.trackSpawn({
      runId: "run-1",
      parentSessionKey: "parent-1",
      childSessionKey: "child-1",
      wakeParentOnEnd: true,
    });

    await tracker.handleSubagentEnded({ runId: "run-1", outcome: "ok" });

    expect(wakeParent).toHaveBeenCalledTimes(1);
    const call = wakeParent.mock.calls[0]?.[0] as any;
    expect(call.sessionKey).toBe("parent-1");
    expect(call.deliver).toBe(false);
    expect(call.channel).toBe("last");
    expect(call.lane).toBe("sk-sync-wake");
    expect(typeof call.idempotencyKey).toBe("string");
    expect(call.idempotencyKey.length).toBeGreaterThan(0);

    expect(String(call.message)).toContain("SK-Sync wake: subagent ended");
    expect(String(call.message)).toContain("status=DONE");
    expect(String(call.message)).toContain("child=child-1");
    expect(String(call.message)).toContain("run=run-1");
    expect(String(call.message)).toContain("outcome=ok");

    // Ensure de-dupe: second end event doesn't spam parent.
    await tracker.handleSubagentEnded({ runId: "run-1", outcome: "ok" });
    expect(wakeParent).toHaveBeenCalledTimes(1);
  });

  it("calls wakeParent once on subagent end when enabled by default (undefined)", async () => {
    const logger = { warn: vi.fn() };
    const wakeParent = vi.fn(async (_params: Record<string, unknown>) => ({ status: "ok" }));

    const tracker = createWakeParentOnEndTracker({ logger, wakeParent });

    tracker.trackSpawn({
      runId: "run-2",
      parentSessionKey: "parent-2",
      childSessionKey: "child-2",
      wakeParentOnEnd: undefined,
    });

    await tracker.handleSubagentEnded({ runId: "run-2", outcome: "timeout" });

    expect(wakeParent).toHaveBeenCalledTimes(1);
    const call = wakeParent.mock.calls[0]?.[0] as any;
    expect(String(call.message)).toContain("status=FAILED");
    expect(String(call.message)).toContain("outcome=timeout");
  });

  it("resolves runId via childSessionKey when runId is missing (agent_end fast-path)", async () => {
    const logger = { warn: vi.fn() };
    const wakeParent = vi.fn(async (_params: Record<string, unknown>) => ({ status: "ok" }));

    const tracker = createWakeParentOnEndTracker({ logger, wakeParent });

    tracker.trackSpawn({
      runId: "run-4",
      parentSessionKey: "parent-4",
      childSessionKey: "child-4",
      wakeParentOnEnd: true,
    });

    // Simulate agent_end where we may not have a runId in the hook payload.
    await tracker.handleSubagentEnded({ childSessionKey: "child-4", outcome: "ok" });

    expect(wakeParent).toHaveBeenCalledTimes(1);
    const call = wakeParent.mock.calls[0]?.[0] as any;
    expect(call.sessionKey).toBe("parent-4");
    expect(String(call.message)).toContain("child=child-4");
    expect(String(call.message)).toContain("run=run-4");
  });

  it("does not call wakeParent when wakeParentOnEnd is explicitly false", async () => {
    const logger = { warn: vi.fn() };
    const wakeParent = vi.fn(async (_params: Record<string, unknown>) => ({ status: "ok" }));

    const tracker = createWakeParentOnEndTracker({ logger, wakeParent });

    tracker.trackSpawn({
      runId: "run-3",
      parentSessionKey: "parent-3",
      childSessionKey: "child-3",
      wakeParentOnEnd: false,
    });

    await tracker.handleSubagentEnded({ runId: "run-3", outcome: "ok" });

    expect(wakeParent).toHaveBeenCalledTimes(0);
  });
});
