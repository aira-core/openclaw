import { describe, expect, it } from "vitest";
import { resolveSkSyncCanonicalization } from "./index.js";

describe("sk-sync externalId canonicalization", () => {
  it("canonicalizes bare IDs and defaults names/titles to keys", () => {
    const canon = resolveSkSyncCanonicalization({
      projectExternalId: "undefined",
      workItemExternalId: "undefined",
      taskExternalId: "T-1",
    });

    expect(canon.projectExternalId).toBe("project:undefined");
    expect(canon.workItemExternalId).toBe("workitem:undefined:undefined");
    expect(canon.taskExternalId).toBe("task:undefined:undefined:T-1");

    // Default naming fallbacks use the *key*, not the full externalId.
    expect(canon.projectName).toBe("undefined");
    expect(canon.workItemTitle).toBe("undefined");
    expect(canon.taskTitle).toBe("T-1");

    expect(canon.projectKey).toBe("undefined");
    expect(canon.workItemKey).toBe("undefined");
    expect(canon.taskKey).toBe("T-1");
  });

  it("keeps already-canonical IDs (and defaults names/titles to keys)", () => {
    const canon = resolveSkSyncCanonicalization({
      projectExternalId: "project:p",
      workItemExternalId: "workitem:p:W-1",
      taskExternalId: "task:p:W-1:T-9",
    });

    expect(canon.projectExternalId).toBe("project:p");
    expect(canon.workItemExternalId).toBe("workitem:p:W-1");
    expect(canon.taskExternalId).toBe("task:p:W-1:T-9");

    expect(canon.projectName).toBe("p");
    expect(canon.workItemTitle).toBe("W-1");
    expect(canon.taskTitle).toBe("T-9");
  });

  it("throws when canonical IDs mismatch (projectKey/workItemKey)", () => {
    expect(() =>
      resolveSkSyncCanonicalization({
        projectExternalId: "project:projA",
        workItemExternalId: "workitem:projB:WI-1",
      }),
    ).toThrow(/mismatch/i);

    expect(() =>
      resolveSkSyncCanonicalization({
        projectExternalId: "project:projA",
        workItemExternalId: "workitem:projA:WI-1",
        taskExternalId: "task:projA:WI-2:T-1",
      }),
    ).toThrow(/mismatch/i);
  });
});
