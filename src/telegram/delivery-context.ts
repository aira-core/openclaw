import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type TelegramDeliveryContext = {
  /** Correlates a gateway/tool dispatch with downstream provider/HTTP logs. */
  deliveryId: string;
  accountId?: string;
  chatId?: string;
  operation?: string;
};

const telegramDeliveryAls = new AsyncLocalStorage<TelegramDeliveryContext>();

export function newTelegramDeliveryId(): string {
  return randomUUID();
}

export function getTelegramDeliveryContext(): TelegramDeliveryContext | undefined {
  return telegramDeliveryAls.getStore();
}

export function runWithTelegramDeliveryContext<T>(
  ctx: TelegramDeliveryContext,
  fn: () => Promise<T>,
): Promise<T> {
  return telegramDeliveryAls.run(ctx, fn);
}

export function withTelegramDeliveryContext<T>(
  ctx: Partial<TelegramDeliveryContext> & { deliveryId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const current = telegramDeliveryAls.getStore();
  const deliveryId = ctx.deliveryId ?? current?.deliveryId ?? newTelegramDeliveryId();
  return telegramDeliveryAls.run(
    {
      deliveryId,
      accountId: ctx.accountId ?? current?.accountId,
      chatId: ctx.chatId ?? current?.chatId,
      operation: ctx.operation ?? current?.operation,
    },
    fn,
  );
}

export function resetTelegramDeliveryContextForTests(): void {
  // AsyncLocalStorage cannot be forcibly cleared across async boundaries; this is mainly here
  // to provide a stable API for tests that use synchronous contexts.
  // We intentionally don't keep global mutable state beyond ALS.
}
