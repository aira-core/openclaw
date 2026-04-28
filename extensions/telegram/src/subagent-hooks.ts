import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId as normalizeTelegramAccountId,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTelegramAccountConfig } from "./account-config.js";
import { parseTelegramTarget } from "./targets.js";
import { getTelegramThreadBindingManager } from "./thread-bindings.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

type TelegramSubagentContext = {
  requesterSessionKey?: string;
};

type TelegramSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId?: string;
  label?: string;
};

type TelegramSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

type TelegramSubagentEndedEvent = {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: string;
  reason?: string;
};

type TelegramDeliveryOrigin = {
  channel: "telegram";
  accountId: string;
  to: string;
  threadId?: string;
};

type TelegramSubagentSpawningResult =
  | { status: "ok"; threadBindingReady?: boolean; deliveryOrigin?: TelegramDeliveryOrigin }
  | { status: "error"; error: string }
  | undefined;

type TelegramSubagentDeliveryTargetResult =
  | {
      origin: TelegramDeliveryOrigin;
    }
  | undefined;

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function resolveAccountId(raw?: string): string {
  return normalizeTelegramAccountId(raw) || DEFAULT_ACCOUNT_ID;
}

function normalizeThreadId(raw?: string | number): string | undefined {
  return raw != null && raw !== "" ? normalizeOptionalString(String(raw)) : undefined;
}

function normalizeBoolean(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

function resolveThreadBindingFlags(
  cfg: OpenClawConfig,
  accountId: string,
): { enabled: boolean; spawnSubagentSessions: boolean } {
  const baseThreadBindings = cfg.channels?.telegram?.threadBindings;
  const accountThreadBindings = resolveTelegramAccountConfig(cfg, accountId)?.threadBindings;
  return {
    enabled:
      normalizeBoolean(accountThreadBindings?.enabled) ??
      normalizeBoolean(baseThreadBindings?.enabled) ??
      normalizeBoolean(cfg.session?.threadBindings?.enabled) ??
      true,
    spawnSubagentSessions:
      normalizeBoolean(accountThreadBindings?.spawnSubagentSessions) ??
      normalizeBoolean(baseThreadBindings?.spawnSubagentSessions) ??
      false,
  };
}

function resolveTelegramRequesterConversation(params: {
  accountId?: string;
  to?: string;
  threadId?: string | number;
}): {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  deliveryTo: string;
  deliveryThreadId?: string;
} | null {
  const rawTo = normalizeOptionalString(params.to) ?? "";
  if (!rawTo) {
    return null;
  }
  const parsedTarget = parseTelegramTarget(rawTo);
  const chatId = normalizeOptionalString(parsedTarget.chatId) ?? "";
  if (!chatId) {
    return null;
  }

  const targetThreadId =
    parsedTarget.messageThreadId != null
      ? String(parsedTarget.messageThreadId)
      : normalizeThreadId(params.threadId);

  if (targetThreadId) {
    const parsedTopic = parseTelegramTopicConversation({
      conversationId: targetThreadId,
      parentConversationId: chatId,
    });
    if (!parsedTopic) {
      return null;
    }
    return {
      accountId: resolveAccountId(params.accountId),
      conversationId: parsedTopic.canonicalConversationId,
      parentConversationId: parsedTopic.chatId,
      deliveryTo: `telegram:${parsedTopic.chatId}`,
      deliveryThreadId: parsedTopic.topicId,
    };
  }

  // F4 intentionally binds only existing current conversations. Direct chats are
  // current conversations; non-topic groups are not bound as subagent sessions.
  if (parsedTarget.chatType === "direct") {
    return {
      accountId: resolveAccountId(params.accountId),
      conversationId: chatId,
      deliveryTo: `telegram:${chatId}`,
    };
  }

  return null;
}

function resolveTelegramBindingDeliveryOrigin(
  binding: SessionBindingRecord,
  fallbackAccountId: string,
): TelegramDeliveryOrigin | null {
  const metadata = binding.metadata ?? {};
  const deliveryTo = normalizeOptionalString(metadata.deliveryTo);
  const deliveryThreadId = normalizeThreadId(
    typeof metadata.deliveryThreadId === "string" || typeof metadata.deliveryThreadId === "number"
      ? metadata.deliveryThreadId
      : undefined,
  );
  if (deliveryTo) {
    return {
      channel: "telegram",
      accountId: binding.conversation.accountId || fallbackAccountId,
      to: deliveryTo,
      ...(deliveryThreadId ? { threadId: deliveryThreadId } : {}),
    };
  }

  const parsedTopic = parseTelegramTopicConversation({
    conversationId: binding.conversation.conversationId,
    parentConversationId: binding.conversation.parentConversationId,
  });
  if (parsedTopic) {
    return {
      channel: "telegram",
      accountId: binding.conversation.accountId || fallbackAccountId,
      to: `telegram:${parsedTopic.chatId}`,
      threadId: parsedTopic.topicId,
    };
  }

  const conversationId = normalizeOptionalString(binding.conversation.conversationId);
  if (!conversationId) {
    return null;
  }
  return {
    channel: "telegram",
    accountId: binding.conversation.accountId || fallbackAccountId,
    to: `telegram:${conversationId}`,
  };
}

function resolveMatchingChildBinding(params: {
  accountId?: string;
  childSessionKey: string;
  requesterOrigin?: {
    to?: string;
    threadId?: string | number;
  };
}): SessionBindingRecord | null {
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return null;
  }
  const accountId = normalizeOptionalString(params.accountId);
  const bindings = getSessionBindingService()
    .listBySession(childSessionKey)
    .filter(
      (entry) =>
        entry.targetKind === "subagent" &&
        entry.conversation.channel === "telegram" &&
        (!accountId || entry.conversation.accountId === accountId),
    );
  if (bindings.length === 0) {
    return null;
  }

  const requesterConversation = resolveTelegramRequesterConversation({
    accountId,
    to: params.requesterOrigin?.to,
    threadId: params.requesterOrigin?.threadId,
  });
  if (requesterConversation) {
    const matching = bindings.find(
      (entry) =>
        entry.conversation.conversationId === requesterConversation.conversationId &&
        (!requesterConversation.parentConversationId ||
          entry.conversation.parentConversationId === requesterConversation.parentConversationId),
    );
    if (matching) {
      return matching;
    }
  }

  return bindings.length === 1 ? bindings[0] : null;
}

export async function handleTelegramSubagentSpawning(
  api: OpenClawPluginApi,
  event: TelegramSubagentSpawningEvent,
  _ctx?: TelegramSubagentContext,
): Promise<TelegramSubagentSpawningResult> {
  if (!event.threadRequested) {
    return undefined;
  }
  const channel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (channel !== "telegram") {
    return undefined;
  }

  const accountId = resolveAccountId(event.requester?.accountId);
  const flags = resolveThreadBindingFlags(api.config, accountId);
  if (!flags.enabled) {
    return {
      status: "error",
      error:
        "Telegram thread bindings are disabled (set channels.telegram.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
    };
  }
  if (!flags.spawnSubagentSessions) {
    return {
      status: "error",
      error:
        "Telegram thread-bound subagent spawns are disabled for this account (set channels.telegram.threadBindings.spawnSubagentSessions=true to enable).",
    };
  }

  const conversation = resolveTelegramRequesterConversation({
    accountId,
    to: event.requester?.to,
    threadId: event.requester?.threadId,
  });
  if (!conversation) {
    return {
      status: "error",
      error:
        "Telegram current-conversation binding is only available in direct chats or existing forum topics.",
    };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({ channel: "telegram", accountId });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return {
      status: "error",
      error: `No Telegram session binding adapter available for account "${accountId}". Is the Telegram channel running?`,
    };
  }
  if (!capabilities.placements.includes("current")) {
    return {
      status: "error",
      error: `Telegram session binding adapter for account "${accountId}" does not support current-conversation bindings.`,
    };
  }

  try {
    const binding = await bindingService.bind({
      targetSessionKey: event.childSessionKey,
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId,
        conversationId: conversation.conversationId,
        ...(conversation.parentConversationId
          ? { parentConversationId: conversation.parentConversationId }
          : {}),
      },
      placement: "current",
      metadata: {
        agentId: normalizeOptionalString(event.agentId),
        label: normalizeOptionalString(event.label),
        boundBy: "system",
        deliveryTo: conversation.deliveryTo,
        deliveryThreadId: conversation.deliveryThreadId,
      },
    });
    const deliveryOrigin =
      resolveTelegramBindingDeliveryOrigin(binding, accountId) ??
      ({
        channel: "telegram",
        accountId,
        to: conversation.deliveryTo,
        ...(conversation.deliveryThreadId ? { threadId: conversation.deliveryThreadId } : {}),
      } satisfies TelegramDeliveryOrigin);
    return {
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin,
    };
  } catch (err) {
    return {
      status: "error",
      error: `Telegram current-conversation bind failed: ${summarizeError(err)}`,
    };
  }
}

export function handleTelegramSubagentDeliveryTarget(
  event: TelegramSubagentDeliveryTargetEvent,
): TelegramSubagentDeliveryTargetResult {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "telegram") {
    return undefined;
  }

  const binding = resolveMatchingChildBinding({
    accountId: event.requesterOrigin?.accountId,
    childSessionKey: event.childSessionKey,
    requesterOrigin: {
      to: event.requesterOrigin?.to,
      threadId: event.requesterOrigin?.threadId,
    },
  });
  if (!binding) {
    return undefined;
  }
  const origin = resolveTelegramBindingDeliveryOrigin(
    binding,
    resolveAccountId(event.requesterOrigin?.accountId),
  );
  return origin ? { origin } : undefined;
}

export async function handleTelegramSubagentEnded(
  event: TelegramSubagentEndedEvent,
): Promise<void> {
  if (event.targetKind && event.targetKind !== "subagent") {
    return;
  }
  const targetSessionKey = normalizeOptionalString(event.targetSessionKey);
  if (!targetSessionKey) {
    return;
  }
  const accountId = normalizeOptionalString(event.accountId);
  if (accountId) {
    const manager = getTelegramThreadBindingManager(accountId);
    manager?.unbindBySessionKey({
      targetSessionKey,
      reason: event.reason,
      sendFarewell: false,
    });
    return;
  }
  await getSessionBindingService().unbind({
    targetSessionKey,
    reason: event.reason ?? "subagent-ended",
  });
}
