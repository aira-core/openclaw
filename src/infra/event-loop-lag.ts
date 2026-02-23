import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export type EventLoopLagSnapshot = {
  unit: "ms";
  enabled: boolean;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

let histogram: IntervalHistogram | null = null;

export function startEventLoopLagMonitor(opts?: { resolutionMs?: number }) {
  if (histogram) {
    return;
  }
  try {
    // monitorEventLoopDelay reports nanoseconds.
    const resolution = Math.max(1, Math.round(opts?.resolutionMs ?? 20));
    histogram = monitorEventLoopDelay({ resolution });
    histogram.enable();
  } catch {
    histogram = null;
  }
}

function nsToMs(ns: number): number {
  if (!Number.isFinite(ns)) {
    return 0;
  }
  return ns / 1e6;
}

export function getEventLoopLagSnapshot(): EventLoopLagSnapshot | null {
  if (!histogram) {
    return null;
  }
  // Ensure monitor is enabled; older Node versions might behave oddly.
  try {
    const snap: EventLoopLagSnapshot = {
      unit: "ms",
      enabled: true,
      p50: nsToMs(histogram.percentile(50)),
      p95: nsToMs(histogram.percentile(95)),
      p99: nsToMs(histogram.percentile(99)),
      max: nsToMs(histogram.max),
      mean: nsToMs(histogram.mean),
    };
    return snap;
  } catch {
    return null;
  }
}

export function __resetEventLoopLagMonitorForTest() {
  histogram = null;
}
