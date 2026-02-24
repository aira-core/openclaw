import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileSuperKanban } from "./reconciler.js";

async function mkTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sk-reconcile-"));
}

describe("super-kanban reconciler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a drift report in dry-run without calling fetch", async () => {
    const stateDir = await mkTmpDir();
    const agentId = "work";
    const sessionId = "sess-1";
    const sessionKey = "sk-session-key-1";

    await fs.mkdir(path.join(stateDir, "agents", agentId, "sessions"), { recursive: true });

    // sessions.json: { [sessionKey]: { sessionId, label } }
    const sessionsIndex = {
      [sessionKey]: {
        sessionId,
        label: "SK:TASK:task:demo",
      },
    };
    await fs.writeFile(
      path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
      JSON.stringify(sessionsIndex),
      "utf8",
    );

    const transcriptLines = [
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: 1700000000000,
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: 1700000001000,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            {
              type: "toolCall",
              id: "tc1",
              name: "functions.read",
              arguments: { path: "/tmp/file" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "tr1",
        timestamp: 1700000002000,
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "functions.read",
          isError: false,
          content: [{ type: "text", text: "done" }],
        },
      }),
    ];

    await fs.writeFile(
      path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
      `${transcriptLines.join("\n")}\n`,
      "utf8",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch should not be called in dry-run");
      }),
    );

    const report = await reconcileSuperKanban({
      mode: "dry-run",
      filter: { stateDir },
      cfg: {
        baseUrl: "https://sk.example/api",
        token: "t",
        attachPath: "/sessions/attach",
        messagesPath: "/messages/record",
        toolCallsPath: "/tool-calls/record",
        timeoutMs: 2000,
        maxTextChars: 9999,
        maxToolResultChars: 9999,
      },
      coreConfig: { logging: { redactSensitive: "off" } } as any,
      logger: console as any,
      previewLimit: 2,
    });

    expect(report.sessionsMatched).toBe(1);
    expect(report.totals.messages).toBe(3);
    expect(report.totals.toolCalls).toBe(2);

    const s = report.sessions[0]!;
    expect(s.sessionKey).toBe(sessionKey);
    expect(s.entityExternalId).toBe("task:demo");
    expect(s.preview?.messages.length).toBeGreaterThan(0);
    expect(s.preview?.toolCalls.length).toBeGreaterThan(0);
  });

  it("posts attach/messages/tool-calls in --fix mode (idempotent replay)", async () => {
    const stateDir = await mkTmpDir();
    const agentId = "work";
    const sessionId = "sess-1";
    const sessionKey = "sk-session-key-1";

    await fs.mkdir(path.join(stateDir, "agents", agentId, "sessions"), { recursive: true });

    const sessionsIndex = {
      [sessionKey]: {
        sessionId,
        label: "SK:TASK:task:demo",
      },
    };
    await fs.writeFile(
      path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
      JSON.stringify(sessionsIndex),
      "utf8",
    );

    const transcriptLines = [
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: 1700000000000,
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: 1700000001000,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            {
              type: "toolCall",
              id: "tc1",
              name: "functions.read",
              arguments: { path: "/tmp/file" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "tr1",
        timestamp: 1700000002000,
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "functions.read",
          isError: false,
          content: [{ type: "text", text: "done" }],
        },
      }),
    ];

    await fs.writeFile(
      path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
      `${transcriptLines.join("\n")}\n`,
      "utf8",
    );

    const calls: Array<{ url: string; body: any }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
        } as any;
      }),
    );

    const report = await reconcileSuperKanban({
      mode: "fix",
      filter: { stateDir },
      cfg: {
        baseUrl: "https://sk.example/api",
        token: "t",
        attachPath: "/sessions/attach",
        messagesPath: "/messages/record",
        toolCallsPath: "/tool-calls/record",
        timeoutMs: 2000,
        maxTextChars: 9999,
        maxToolResultChars: 9999,
      },
      coreConfig: { logging: { redactSensitive: "off" } } as any,
      logger: console as any,
      previewLimit: 0,
    });

    expect(report.sessionsMatched).toBe(1);
    // attach(1) + messages(3) + toolCalls(2)
    expect(calls.length).toBe(6);

    expect(calls[0]!.url).toBe("https://sk.example/api/sessions/attach");
    expect(calls[1]!.url).toBe("https://sk.example/api/messages/record");

    const anyTool = calls.find((c) => c.url.endsWith("/tool-calls/record"));
    expect(anyTool).toBeTruthy();

    // toolCallKey must be stable/idempotent across replays.
    const toolCalls = calls.filter((c) => c.url.endsWith("/tool-calls/record"));
    expect(toolCalls.map((c) => c.body.toolCallKey)).toEqual([
      `${sessionKey}:tc1`,
      `${sessionKey}:tc1`,
    ]);
  });
});
