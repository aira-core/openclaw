import { describe, expect, it } from "vitest";
import { callGateway } from "../../src/gateway/call.js";
import { createWakeParentOnEndTracker } from "./index.js";

/**
 * Live smoke test (manual): ensures wakeParentOnEnd can start an agent run in the parent session
 * using deliver=false (works for internal webchat sessions too).
 *
 * Run:
 *   OPENCLAW_LIVE_TEST=1 PARENT_SESSION_KEY='<agent:...>' pnpm -s vitest extensions/sk-sync/wake-parent-on-end.live.smoke.test.ts
 */

describe("sk-sync wakeParentOnEnd (live smoke)", () => {
  const enabled = process.env.OPENCLAW_LIVE_TEST === "1";
  const parentSessionKey = process.env.PARENT_SESSION_KEY;

  const testFn = enabled ? it : it.skip;

  testFn("wakes parent session via gateway agent RPC (deliver=false) and completes", async () => {
    if (!parentSessionKey) {
      throw new Error("Missing env PARENT_SESSION_KEY");
    }

    let wakeRunId: string | null = null;

    const tracker = createWakeParentOnEndTracker({
      logger: {
        warn: () => {
          // keep smoke output clean
        },
      },
      wakeParent: async (input) => {
        const res = await callGateway({
          method: "agent",
          params: {
            sessionKey: input.sessionKey,
            message: input.message,
            deliver: input.deliver,
            channel: input.channel,
            idempotencyKey: input.idempotencyKey,
            lane: input.lane,
          },
        });
        wakeRunId = typeof (res as any)?.runId === "string" ? String((res as any).runId) : null;
        return res;
      },
    });

    tracker.trackSpawn({
      runId: "live-smoke-run",
      parentSessionKey,
      childSessionKey: "live-smoke-child",
      wakeParentOnEnd: true,
    });

    // Simulate agent_end payload (no runId provided) to exercise childSessionKey fallback.
    await tracker.handleSubagentEnded({ childSessionKey: "live-smoke-child", outcome: "ok" });

    expect(typeof wakeRunId).toBe("string");
    expect(wakeRunId).toBeTruthy();

    const waited = await callGateway({
      method: "agent.wait",
      params: {
        runId: wakeRunId,
        timeoutMs: 30_000,
      },
    });

    expect((waited as any)?.status).not.toBe("timeout");
  });
});
