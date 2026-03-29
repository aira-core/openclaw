import net from "node:net";
import { isIpInCidr } from "../../shared/net/ip.js";

export type LoopbackListenSpec = {
  host: "127.0.0.1" | "::1";
  port: number;
};

export type SocksProxyPolicy = {
  allowHosts: string[];
  allowCidrs: string[];
};

export function parseLoopbackListenSpec(raw: string): LoopbackListenSpec {
  const value = raw.trim();
  if (!value) {
    throw new Error("listen address required");
  }
  const numericOnly = /^\d+$/.test(value);
  if (numericOnly) {
    return { host: "127.0.0.1", port: parsePort(value) };
  }
  if (value.startsWith("[")) {
    const match = value.match(/^\[(.+)]:(\d+)$/);
    if (!match) {
      throw new Error(`invalid listen address: ${raw}`);
    }
    const host = normalizeLoopbackHost(match[1] ?? "");
    return { host, port: parsePort(match[2] ?? "") };
  }
  const parts = value.split(":");
  if (parts.length !== 2) {
    throw new Error(`invalid listen address: ${raw}`);
  }
  const host = normalizeLoopbackHost(parts[0] ?? "");
  return { host, port: parsePort(parts[1] ?? "") };
}

export function isProxyTargetAllowed(host: string, policy: SocksProxyPolicy): boolean {
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost) {
    return false;
  }
  const normalizedAllowHosts = policy.allowHosts.map((entry) => entry.trim().toLowerCase());
  const normalizedAllowCidrs = policy.allowCidrs.map((entry) => entry.trim()).filter(Boolean);
  const literalIp = net.isIP(normalizedHost) !== 0;
  if (literalIp && normalizedAllowCidrs.some((cidr) => isIpInCidr(normalizedHost, cidr))) {
    return true;
  }
  return normalizedAllowHosts.some((rule) => hostRuleMatches(normalizedHost, rule));
}

function normalizeLoopbackHost(host: string): "127.0.0.1" | "::1" {
  const normalized = host.trim().toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "localhost") {
    return "127.0.0.1";
  }
  if (normalized === "::1") {
    return "::1";
  }
  throw new Error("listen host must be loopback (127.0.0.1 or ::1)");
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

function hostRuleMatches(host: string, rule: string): boolean {
  if (!rule) {
    return false;
  }
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === rule;
}
