import { describe, expect, it, vi } from "vitest";
import { withTelegramDeliveryContext } from "./delivery-context.js";

const telegramDiagEvent = vi.fn();

vi.mock("./diag.js", () => ({
  isTelegramDiagEnabled: () => true,
  telegramDiagEvent: (...args: unknown[]) => telegramDiagEvent(...args),
}));

describe("resolveTelegramFetch diagnostic wrapper", () => {
  it("logs telegram.http.fetch with deliveryId, redacted path, and payloadHash", async () => {
    const { resolveTelegramFetch } = await import("./fetch.js");

    const baseFetch = vi.fn(async () => new Response("ok"));
    const fetchImpl = resolveTelegramFetch(baseFetch) as typeof fetch;

    await withTelegramDeliveryContext(
      {
        deliveryId: "d1",
        accountId: "acc",
        chatId: "123",
        operation: "sendVoice",
      },
      () =>
        fetchImpl("https://api.telegram.org/bot123:ABC/sendVoice", {
          method: "POST",
          body: "a=1",
        }),
    );

    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(telegramDiagEvent).toHaveBeenCalledWith(
      "telegram.http.fetch",
      expect.objectContaining({
        deliveryId: "d1",
        accountId: "acc",
        chatId: "123",
        operation: "sendVoice",
        httpMethod: "POST",
        apiMethod: "sendVoice",
        path: "/bot<redacted>/sendVoice",
        payloadHash: expect.any(String),
      }),
    );
  });
});
