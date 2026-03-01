import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SkClient } from "./index.js";

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(returnJson: any) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(returnJson),
    } as any;
  });
  return { fn, calls };
}

describe("sk-sync: includeArchived defaults + sk_set_archived client methods", () => {
  const baseUrl = "http://sk.local/api";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SkClient.listProjects defaults includeArchived=false (query param)", async () => {
    const { fn, calls } = mockFetch({ data: { items: [] } });
    vi.stubGlobal("fetch", fn as any);

    const sk = new SkClient({
      baseUrl,
      timeoutMs: 1000,
      bearerToken: "read-token",
      apiKey: "write-token",
    });

    await sk.listProjects();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://sk.local/api/projects?includeArchived=false");
  });

  it("SkClient.listProjects includeArchived=true when requested", async () => {
    const { fn, calls } = mockFetch({ data: { items: [] } });
    vi.stubGlobal("fetch", fn as any);

    const sk = new SkClient({
      baseUrl,
      timeoutMs: 1000,
      bearerToken: "read-token",
      apiKey: "write-token",
    });

    await sk.listProjects({ includeArchived: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://sk.local/api/projects?includeArchived=true");
  });

  it("SkClient.patchProjectArchived uses PATCH /projects/:id {archived}", async () => {
    const { fn, calls } = mockFetch({});
    vi.stubGlobal("fetch", fn as any);

    const sk = new SkClient({
      baseUrl,
      timeoutMs: 1000,
      bearerToken: "read-token",
      apiKey: "write-token",
    });

    await sk.patchProjectArchived({ projectId: "p1", archived: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://sk.local/api/projects/p1");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ archived: true }));
  });

  it("SkClient.patchWorkItemArchived uses PATCH /work-items/:id {archived}", async () => {
    const { fn, calls } = mockFetch({});
    vi.stubGlobal("fetch", fn as any);

    const sk = new SkClient({
      baseUrl,
      timeoutMs: 1000,
      bearerToken: "read-token",
      apiKey: "write-token",
    });

    await sk.patchWorkItemArchived({ workItemId: "wi1", archived: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://sk.local/api/work-items/wi1");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ archived: false }));
  });

  it("SkClient.patchTaskArchived uses PATCH /tasks/:id {archived}", async () => {
    const { fn, calls } = mockFetch({});
    vi.stubGlobal("fetch", fn as any);

    const sk = new SkClient({
      baseUrl,
      timeoutMs: 1000,
      bearerToken: "read-token",
      apiKey: "write-token",
    });

    await sk.patchTaskArchived({ taskId: "t1", archived: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://sk.local/api/tasks/t1");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ archived: true }));
  });
});
