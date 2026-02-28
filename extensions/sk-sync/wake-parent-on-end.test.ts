import { describe, expect, it, vi } from "vitest";
import { createWakeParentOnEndTracker, resolveWakeParentOnEnd } from "./index.js";

describe("sk-sync wakeParentOnEnd", () => {
  it("defaults wakeParentOnEnd to true (opt-out with false)", () => {
    expect(resolveWakeParentOnEnd(undefined)).toBe(true);
    expect(resolveWakeParentOnEnd(true)).toBe(true);
    expect(resolveWakeParentOnEnd(false)).toBe(false);
  });

  it("sends sessions_send to parent once on subagent end when enabled (explicit true)", async () => {
    const logger = { warn: vi.fn() };
    const sessionsSend = vi.fn(async (_params: Record<string, unknown>) => ({ status: "ok" }));

    const tracker = createWakeParentOnEndTracker({ logger });
    tracker.setSessionsSend(sessionsSend);

    tracker.trackSpawn({
      runId: "run-1",
      parentSessionKey: "parent-1",
      childSessionKey: "child-1",
      wakeParentOnEnd: true,
    });

    await tracker.handleSubagentEnded({ runId: "run-1", outcome: "ok" });

    expect(sessionsSend).toHaveBeenCalledTimes(1);
    const call = sessionsSend.mock.calls[0]?.[0] as any;
    expect(call.sessionKey).toBe("parent-1");
    expect(call.timeoutSeconds).toBe(0);

    const payload = JSON.parse(String(call.message));
    expect(payload.type).toBe("sk_sync_wake_parent_on_end");
    expect(payload.runId).toBe("run-1");
    expect(payload.childSessionKey).toBe("child-1");
    expect(payload.outcome).toBe("ok");

    // Ensure de-dupe: second end event doesn't spam parent.
    await tracker.handleSubagentEnded({ runId: "run-1", outcome: "ok" });
    expect(sessionsSend).toHaveBeenCalledTimes(1);
  });

  it("sends sessions_send to parent once on subagent end when enabled by default (undefined)", async () => {
    const logger = { warn: vi.fn() };
    const sessionsSend = vi.fn(async (_params: Record<string, unknown>) => ({ status: "ok" }));

    const tracker = createWakeParentOnEndTracker({ logger });
    tracker.setSessionsSend(sessionsSend);

    tracker.trackSpawn({
      runId: "run-2",
      parentSessionKey: "parent-2",
      childSessionKey: "child-2",
      wakeParentOnEnd: undefined,
    });

    await tracker.handleSubagentEnded({ runId: "run-2", outcome: "timeout" });

    expect(sessionsSend).toHaveBeenCalledTimes(1);
    const call = sessionsSend.mock.calls[0]?.[0] as any;
    const payload = JSON.parse(String(call.message));
    expect(payload.outcome).toBe("timeout");
  });

  it("does not send sessions_send when wakeParentOnEnd is explicitly false", async () => {
    const logger = { warn: vi.fn() };
    const sessionsSend = vi.fn(async (_params: Record<string, unknown>) => ({ status: "ok" }));

    const tracker = createWakeParentOnEndTracker({ logger });
    tracker.setSessionsSend(sessionsSend);

    tracker.trackSpawn({
      runId: "run-3",
      parentSessionKey: "parent-3",
      childSessionKey: "child-3",
      wakeParentOnEnd: false,
    });

    await tracker.handleSubagentEnded({ runId: "run-3", outcome: "ok" });

    expect(sessionsSend).toHaveBeenCalledTimes(0);
  });
});
