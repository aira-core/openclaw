import { describe, expect, it } from "vitest";
import { isProxyTargetAllowed, parseLoopbackListenSpec } from "./proxy-socks-helpers.js";

describe("proxy-socks helpers", () => {
  it("parses loopback listen addresses", () => {
    expect(parseLoopbackListenSpec("127.0.0.1:1080")).toEqual({ host: "127.0.0.1", port: 1080 });
    expect(parseLoopbackListenSpec("[::1]:9999")).toEqual({ host: "::1", port: 9999 });
    expect(parseLoopbackListenSpec("9050")).toEqual({ host: "127.0.0.1", port: 9050 });
  });

  it("rejects non-loopback listen addresses", () => {
    expect(() => parseLoopbackListenSpec("0.0.0.0:1080")).toThrow(/loopback/i);
  });

  it("matches exact, wildcard, and cidr rules", () => {
    const policy = {
      allowHosts: ["printer.lan", "*.corp.example"],
      allowCidrs: ["192.168.1.0/24", "fd00::/8"],
    };
    expect(isProxyTargetAllowed("printer.lan", policy)).toBe(true);
    expect(isProxyTargetAllowed("api.corp.example", policy)).toBe(true);
    expect(isProxyTargetAllowed("192.168.1.55", policy)).toBe(true);
    expect(isProxyTargetAllowed("10.0.0.8", policy)).toBe(false);
    expect(isProxyTargetAllowed("example.com", policy)).toBe(false);
  });
});
