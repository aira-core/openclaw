export type GatewayReadinessPhase = "starting" | "listening" | "ready";

type ReadinessState = {
  phase: GatewayReadinessPhase;
  listeningAt?: number;
  readyAt?: number;
};

const state: ReadinessState = {
  phase: "starting",
};

export function markGatewayListening(): void {
  if (state.phase === "starting") {
    state.phase = "listening";
    state.listeningAt = Date.now();
  }
}

export function markGatewayReady(): void {
  if (state.phase !== "ready") {
    if (!state.listeningAt) {
      state.listeningAt = Date.now();
    }
    state.phase = "ready";
    state.readyAt = Date.now();
  }
}

export function getGatewayReadiness(): ReadinessState {
  return { ...state };
}
