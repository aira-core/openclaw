import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dispatch = vi.fn();
  return {
    dispatch,
    startBrowserControlServiceFromConfig: vi.fn(async () => true),
    createBrowserControlContext: vi.fn(() => ({ mock: true })),
  };
});

vi.mock("./control-service.js", () => ({
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
  createBrowserControlContext: mocks.createBrowserControlContext,
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: mocks.dispatch }),
}));

import { BrowserControlRequestError, fetchBrowserJson } from "./client-fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("fetchBrowserJson error classification", () => {
  it("does not wrap HTTP 4xx/5xx errors as reachability failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      })) as unknown as typeof fetch,
    );

    let caught: unknown;
    try {
      await fetchBrowserJson("http://127.0.0.1:7777/status");
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      name: "BrowserControlRequestError",
      status: 401,
      message: "unauthorized",
    });
    expect(caught).toBeInstanceOf(BrowserControlRequestError);
    expect(String(caught)).not.toContain("Can't reach the OpenClaw browser control service");
    expect(String(caught)).not.toContain("Do NOT retry the browser tool");
  });

  it("wraps network/unreachable errors as reachability failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:7777");
      }) as unknown as typeof fetch,
    );

    await expect(fetchBrowserJson("http://127.0.0.1:7777/status")).rejects.toThrow(
      "Can't reach the OpenClaw browser control service",
    );
  });

  it("does not wrap dispatcher status>=400 errors as reachability failures", async () => {
    mocks.dispatch.mockResolvedValueOnce({ status: 400, body: { error: "bad request" } });

    let caught: unknown;
    try {
      await fetchBrowserJson("/tabs/open?profile=default");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BrowserControlRequestError);
    expect(String(caught)).toContain("bad request");
    expect(String(caught)).not.toContain("Can't reach the OpenClaw browser control service");
    expect(String(caught)).not.toContain("Do NOT retry the browser tool");
  });
});
