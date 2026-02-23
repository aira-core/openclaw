import { monitorEventLoopDelay } from "node:perf_hooks";

export type EventLoopLagSnapshot = {
  enabled: boolean;
  meanMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
  sampledAt: number;
};

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let started = false;

function ensureStarted() {
  if (started) {
    return;
  }
  started = true;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = null;
  }
}

function nsToMs(value: number): number {
  return value / 1e6;
}

export function startEventLoopLagMonitor(): void {
  ensureStarted();
}

export function getEventLoopLagSnapshot(): EventLoopLagSnapshot {
  ensureStarted();
  const sampledAt = Date.now();
  if (!histogram) {
    return { enabled: false, sampledAt };
  }

  // Copy current stats then reset to keep snapshots "recent".
  const snap = {
    enabled: true,
    meanMs: nsToMs(histogram.mean),
    p50Ms: nsToMs(histogram.percentile(50)),
    p95Ms: nsToMs(histogram.percentile(95)),
    p99Ms: nsToMs(histogram.percentile(99)),
    maxMs: nsToMs(histogram.max),
    sampledAt,
  } satisfies EventLoopLagSnapshot;

  histogram.reset();
  return snap;
}
