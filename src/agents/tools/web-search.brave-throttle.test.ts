import { afterEach, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetAllLanes } from "../../process/command-queue.js";
import { createWebSearchTool } from "./web-search.js";

function makeTool() {
  return createWebSearchTool({
    // Minimal config to enable web_search + Brave provider
    config: {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
            apiKey: "brave-test-key",
            timeoutSeconds: 30,
            cacheTtlMinutes: 0,
          },
        },
      },
    } satisfies OpenClawConfig,
  });
}

afterEach(() => {
  resetAllLanes();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("web_search (brave) serializes parallel calls process-wide", { timeout: 20_000 }, async () => {
  const tool = makeTool();
  expect(tool).not.toBeNull();
  if (!tool) {
    return;
  }

  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];

  const fetchMock = vi.fn(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);

    await new Promise<void>((resolve) => releases.push(resolve));

    active -= 1;
    return new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const uniqueQuery = `openclaw brave lane ${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const calls = Array.from({ length: 5 }, (_, i) =>
    tool.execute(String(i), { query: uniqueQuery, count: 1 } as Record<string, unknown>),
  );

  // Allow the first fetch to start.
  await vi.waitFor(
    () => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
    { timeout: 2_000 },
  );

  // Release requests one by one. Each request should enter fetch only after the
  // previous one has completed.
  for (let i = 0; i < calls.length; i += 1) {
    await vi.waitFor(
      () => {
        expect(releases.length).toBeGreaterThan(0);
      },
      { timeout: 2_000 },
    );
    const release = releases.shift();
    release?.();
    await Promise.resolve();
  }

  await Promise.all(calls);
  expect(maxActive).toBe(1);
});

test("web_search (brave) respects Retry-After when rate limited", { timeout: 20_000 }, async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);

  const tool = makeTool();
  expect(tool).not.toBeNull();
  if (!tool) {
    return;
  }

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "1" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const uniqueQuery = `rate limit ${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const promise = tool.execute("1", { query: uniqueQuery, count: 1 } as Record<string, unknown>);

  // Allow the first attempt to run.
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // Should not retry before Retry-After (1s).
  await vi.advanceTimersByTimeAsync(999);
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // After the full second, it should retry.
  await vi.advanceTimersByTimeAsync(1);
  await Promise.resolve();

  // Jitter/backoff can add a small offset; advance a bit more to guarantee.
  await vi.advanceTimersByTimeAsync(250);
  await Promise.resolve();

  await promise;
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
