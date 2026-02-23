import { describe, expect, test } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";

async function listen(server: ReturnType<typeof createGatewayHttpServer>): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

describe("gateway HTTP health endpoints", () => {
  test("GET /healthz returns machine-readable JSON", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: {},
      run: async () => {
        const clients = new Set<GatewayWsClient>();
        const httpServer = createGatewayHttpServer({
          canvasHost: null,
          clients,
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const listener = await listen(httpServer);
        try {
          const res = await fetch(`http://127.0.0.1:${listener.port}/healthz`);
          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toContain("application/json");
          const body = (await res.json()) as {
            status?: unknown;
            now?: unknown;
            uptimeMs?: unknown;
          };
          expect(body.status).toBe("ok");
          expect(typeof body.now).toBe("number");
          expect(typeof body.uptimeMs).toBe("number");
        } finally {
          await listener.close();
        }
      },
    });
  });

  test("GET /readyz returns readiness phase JSON", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: {},
      run: async () => {
        const clients = new Set<GatewayWsClient>();
        const httpServer = createGatewayHttpServer({
          canvasHost: null,
          clients,
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const listener = await listen(httpServer);
        try {
          const res = await fetch(`http://127.0.0.1:${listener.port}/readyz`);
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            status?: unknown;
            phase?: unknown;
            now?: unknown;
          };
          expect(body.status).toBe("ok");
          expect(body.phase).toBe("ready");
          expect(typeof body.now).toBe("number");
        } finally {
          await listener.close();
        }
      },
    });
  });
});
