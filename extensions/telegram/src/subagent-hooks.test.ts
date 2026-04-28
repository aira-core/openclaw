import type { OpenClawPluginApi as TelegramEntryPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { registerTelegramSubagentHooks } from "../subagent-hooks-api.js";
import {
  __testing as threadBindingTesting,
  createTelegramThreadBindingManager,
} from "./thread-bindings.js";

const baseConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  channels: {
    telegram: {
      threadBindings: {
        enabled: true,
        spawnSubagentSessions: true,
      },
    },
  },
} as OpenClawConfig;

function registerHandlersForTest(config: OpenClawConfig = baseConfig) {
  return registerHookHandlersForTest<TelegramEntryPluginApi>({
    config: config as unknown as Record<string, unknown>,
    register: registerTelegramSubagentHooks,
  });
}

function createManager(accountId = "default") {
  return createTelegramThreadBindingManager({
    cfg: baseConfig,
    accountId,
    persist: false,
    enableSweeper: false,
  });
}

describe("telegram subagent hook handlers", () => {
  beforeEach(async () => {
    await threadBindingTesting.resetTelegramThreadBindingsForTests();
  });

  it("registers the subagent lifecycle hooks", () => {
    const handlers = registerHandlersForTest();

    expect(handlers.has("subagent_spawning")).toBe(true);
    expect(handlers.has("subagent_delivery_target")).toBe(true);
    expect(handlers.has("subagent_ended")).toBe(true);
  });

  it("fails closed unless spawnSubagentSessions is enabled", async () => {
    createManager();
    const handler = getRequiredHookHandler(
      registerHandlersForTest({ channels: { telegram: {} } } as OpenClawConfig),
      "subagent_spawning",
    );

    await expect(
      handler(
        {
          childSessionKey: "agent:main:subagent:child",
          agentId: "orion",
          mode: "session",
          requester: {
            channel: "telegram",
            accountId: "default",
            to: "telegram:-100200300",
            threadId: "77",
          },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("spawnSubagentSessions"),
    });
  });

  it("honors account-level spawn enablement", async () => {
    createManager("ops");
    const handlers = registerHandlersForTest({
      channels: {
        telegram: {
          threadBindings: { enabled: true, spawnSubagentSessions: false },
          accounts: {
            ops: {
              threadBindings: { spawnSubagentSessions: true },
            },
          },
        },
      },
    } as OpenClawConfig);
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");

    await expect(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:ops-child",
          agentId: "orion",
          mode: "session",
          requester: {
            channel: "telegram",
            accountId: "ops",
            to: "telegram:-100200300",
            threadId: "77",
          },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("binds an existing Telegram forum topic and preserves delivery origin", async () => {
    const manager = createManager();
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    const result = await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:topic-child",
        agentId: "orion",
        label: "Orion",
        mode: "session",
        requester: {
          channel: "telegram",
          accountId: "default",
          to: "telegram:-100200300",
          threadId: "77",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toEqual({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "telegram",
        accountId: "default",
        to: "telegram:-100200300",
        threadId: "77",
      },
    });
    expect(manager.getByConversationId("-100200300:topic:77")).toMatchObject({
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:topic-child",
      metadata: expect.objectContaining({
        deliveryTo: "telegram:-100200300",
        deliveryThreadId: "77",
      }),
    });

    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:topic-child",
          requesterOrigin: {
            channel: "telegram",
            accountId: "default",
            to: "telegram:-100200300",
            threadId: "77",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toEqual({
      origin: {
        channel: "telegram",
        accountId: "default",
        to: "telegram:-100200300",
        threadId: "77",
      },
    });
  });

  it("parses topic targets where the topic id is embedded in requester.to", async () => {
    createManager("ops");
    const spawnHandler = getRequiredHookHandler(registerHandlersForTest(), "subagent_spawning");

    await expect(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:embedded-topic-child",
          agentId: "orion",
          mode: "session",
          requester: {
            channel: "telegram",
            accountId: "ops",
            to: "telegram:-100200300:topic:88",
          },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: "ok",
      deliveryOrigin: {
        channel: "telegram",
        accountId: "ops",
        to: "telegram:-100200300",
        threadId: "88",
      },
    });
  });

  it("cleans up subagent bindings on subagent_ended", async () => {
    const manager = createManager();
    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:ended-child",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
      },
      placement: "current",
    });

    const endedHandler = getRequiredHookHandler(registerHandlersForTest(), "subagent_ended");
    await endedHandler(
      {
        targetSessionKey: "agent:main:subagent:ended-child",
        targetKind: "subagent",
        reason: "done",
        accountId: "default",
      },
      {},
    );

    expect(manager.listBySessionKey("agent:main:subagent:ended-child")).toEqual([]);
  });

  it("no-ops for non-Telegram channels and non-completion delivery", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    await expect(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          agentId: "orion",
          mode: "session",
          requester: { channel: "discord", to: "channel:123" },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toBeUndefined();

    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          requesterOrigin: { channel: "telegram", accountId: "default" },
          expectsCompletionMessage: false,
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });
});
