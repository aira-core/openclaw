import { describe, expect, it } from "vitest";
import { parseSessionFileContext, parseTranscriptLineToEvents } from "./parser.js";

describe("super-kanban-exporter parser", () => {
  it("parses agentId/sessionId/topicId from path", () => {
    const ctx = parseSessionFileContext(
      "/tmp/openclaw/agents/work/sessions/abc-123-topic-my%2Ftopic.jsonl",
    );
    expect(ctx.agentId).toBe("work");
    expect(ctx.sessionId).toBe("abc-123");
    expect(ctx.topicId).toBe("my/topic");
  });

  it("extracts toolCall STARTED events from assistant content", () => {
    const fileCtx = { absPath: "/x.jsonl", agentId: "work", sessionId: "sess-1" };
    const line = JSON.stringify({
      type: "message",
      id: "m1",
      timestamp: 1700000000000,
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
    });

    const parsed = parseTranscriptLineToEvents({ ctx: fileCtx, line });
    expect(parsed).not.toBeNull();
    expect(parsed?.toolCalls.length).toBe(1);
    expect(parsed?.toolCalls[0]?.toolCallId).toBe("tc1");
    expect(parsed?.toolCalls[0]?.toolName).toBe("functions.read");
    expect(parsed?.toolCalls[0]?.status).toBe("STARTED");
    expect(parsed?.toolCalls[0]?.paramsText).toContain("/tmp/file");
  });

  it("maps toolResult role to SUCCEEDED/FAILED tool call completion", () => {
    const fileCtx = { absPath: "/x.jsonl", agentId: "work", sessionId: "sess-1" };
    const okLine = JSON.stringify({
      type: "message",
      id: "m2",
      timestamp: 1700000001000,
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "functions.read",
        isError: false,
        content: [{ type: "text", text: "done" }],
      },
    });

    const parsedOk = parseTranscriptLineToEvents({ ctx: fileCtx, line: okLine });
    expect(parsedOk?.toolCalls[0]?.status).toBe("SUCCEEDED");
    expect(parsedOk?.toolCalls[0]?.resultText).toBe("done");

    const errLine = JSON.stringify({
      type: "message",
      id: "m3",
      timestamp: 1700000002000,
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "functions.read",
        isError: true,
        content: [{ type: "text", text: "boom" }],
      },
    });

    const parsedErr = parseTranscriptLineToEvents({ ctx: fileCtx, line: errLine });
    expect(parsedErr?.toolCalls[0]?.status).toBe("FAILED");
    expect(parsedErr?.toolCalls[0]?.errorText).toBe("boom");
  });
});
