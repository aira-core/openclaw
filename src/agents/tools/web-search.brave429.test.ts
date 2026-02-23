import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./web-search.js";

const { runWebSearch, __resetBraveLane } = __testing;

describe("web_search Brave 429 handling", () => {
  beforeEach(() => {
    __resetBraveLane();
    process.env.BRAVE_SEARCH_MIN_INTERVAL_MS = "0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRAVE_SEARCH_MIN_INTERVAL_MS;
    __resetBraveLane();
  });

  it("retries on 429 (rate limit) and succeeds", async () => {
    const fetchMock = vi.fn();

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { status: 429, code: "RATE_LIMITED" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await runWebSearch({
      query: "openclaw brave 429 retry test",
      count: 1,
      apiKey: "brave-test-key",
      timeoutSeconds: 5,
      cacheTtlMs: 0,
      provider: "brave",
      country: "US",
      search_lang: "en",
      ui_lang: "en",
      freshness: undefined,
      perplexityBaseUrl: undefined,
      perplexityModel: undefined,
      grokModel: undefined,
      grokInlineCitations: false,
    });

    expect(result.provider).toBe("brave");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-429 errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("bad request", {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runWebSearch({
        query: "openclaw brave 400 no retry",
        count: 1,
        apiKey: "brave-test-key",
        timeoutSeconds: 5,
        cacheTtlMs: 0,
        provider: "brave",
        country: "US",
        search_lang: "en",
        ui_lang: "en",
        freshness: undefined,
        perplexityBaseUrl: undefined,
        perplexityModel: undefined,
        grokModel: undefined,
        grokInlineCitations: false,
      }),
    ).rejects.toThrow(/Brave Search API error \(400\)/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
