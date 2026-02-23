export type GatewayReadinessPhase = "starting" | "listening" | "ready" | "error";

export type GatewayReadinessSnapshot = {
  phase: GatewayReadinessPhase;
  since: number;
  phases: Array<{ phase: GatewayReadinessPhase; at: number }>;
};

let readiness: GatewayReadinessSnapshot = {
  phase: "starting",
  since: Date.now(),
  phases: [{ phase: "starting", at: Date.now() }],
};

export function markGatewayReadinessPhase(phase: GatewayReadinessPhase) {
  if (readiness.phase === phase) {
    return;
  }
  const now = Date.now();
  readiness = {
    phase,
    since: now,
    phases: [...readiness.phases, { phase, at: now }],
  };
}

export function getGatewayReadinessSnapshot(): GatewayReadinessSnapshot {
  return readiness;
}

export function __resetGatewayReadinessForTest() {
  const now = Date.now();
  readiness = {
    phase: "starting",
    since: now,
    phases: [{ phase: "starting", at: now }],
  };
}
