import {
  getGatewayReadinessSnapshot,
  markGatewayReadinessPhase,
  type GatewayReadinessSnapshot,
} from "../readiness.js";

export type GatewayReadinessPhase = GatewayReadinessSnapshot["phase"];

type ReadinessState = GatewayReadinessSnapshot;

export function markGatewayListening(): void {
  markGatewayReadinessPhase("listening");
}

export function markGatewayReady(): void {
  markGatewayReadinessPhase("ready");
}

export function getGatewayReadiness(): ReadinessState {
  return getGatewayReadinessSnapshot();
}
