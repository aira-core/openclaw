import { createHash } from "node:crypto";
import * as net from "node:net";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { resolveFetch } from "../infra/fetch.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getTelegramDeliveryContext } from "./delivery-context.js";
import { isTelegramDiagEnabled, telegramDiagEvent } from "./diag.js";
import { resolveTelegramAutoSelectFamilyDecision } from "./network-config.js";

let appliedAutoSelectFamily: boolean | null = null;
const log = createSubsystemLogger("telegram/network");

// Node 22 workaround: enable autoSelectFamily to allow IPv4 fallback on broken IPv6 networks.
// Many networks have IPv6 configured but not routed, causing "Network is unreachable" errors.
// See: https://github.com/nodejs/node/issues/54359
function applyTelegramNetworkWorkarounds(network?: TelegramNetworkConfig): void {
  const decision = resolveTelegramAutoSelectFamilyDecision({ network });
  if (decision.value === null || decision.value === appliedAutoSelectFamily) {
    return;
  }
  appliedAutoSelectFamily = decision.value;

  if (typeof net.setDefaultAutoSelectFamily === "function") {
    try {
      net.setDefaultAutoSelectFamily(decision.value);
      const label = decision.source ? ` (${decision.source})` : "";
      log.info(`telegram: autoSelectFamily=${decision.value}${label}`);
    } catch {
      // ignore if unsupported by the runtime
    }
  }
}

function sha256Hex(value: string): string {
  const hash = createHash("sha256");
  hash.update(value, "utf8");
  return hash.digest("hex");
}

function isTelegramApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === "api.telegram.org";
  } catch {
    return false;
  }
}

function redactTelegramApiPath(pathname: string): { redacted: string; apiMethod?: string } {
  // /bot<token>/<method>
  // /file/bot<token>/<path>
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return { redacted: pathname };
  }
  if (parts[0]?.startsWith("bot")) {
    const apiMethod = parts[1];
    return {
      redacted: `/${["bot<redacted>", ...parts.slice(1)].join("/")}`,
      apiMethod,
    };
  }
  if (parts[0] === "file" && parts[1]?.startsWith("bot")) {
    return {
      redacted: `/${["file", "bot<redacted>", ...parts.slice(2)].join("/")}`,
      apiMethod: "file",
    };
  }
  return { redacted: pathname };
}

function summarizeFetchBody(body: unknown): unknown {
  if (body == null) {
    return null;
  }
  if (typeof body === "string") {
    return { t: "string", len: body.length, sha256: sha256Hex(body) };
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    const s = body.toString();
    return { t: "urlsearchparams", len: s.length, sha256: sha256Hex(s) };
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
    // Avoid hashing buffers in fetch logs; use size only (voice fingerprints are logged upstream).
    return { t: "buffer", bytes: body.length };
  }
  if (body instanceof Uint8Array) {
    return { t: "uint8array", bytes: body.byteLength };
  }
  if (body instanceof ArrayBuffer) {
    return { t: "arraybuffer", bytes: body.byteLength };
  }

  // Best-effort FormData summarization without reading binary payloads.
  const maybeForm = body as { entries?: () => IterableIterator<[string, unknown]> };
  if (typeof maybeForm?.entries === "function") {
    const entries: Array<[string, unknown]> = [];
    try {
      for (const [key, value] of maybeForm.entries()) {
        if (typeof value === "string") {
          entries.push([key, { t: "string", len: value.length, sha256: sha256Hex(value) }]);
          continue;
        }
        const blobLike = value as { size?: number; type?: string; name?: string };
        if (blobLike && typeof blobLike === "object" && typeof blobLike.size === "number") {
          entries.push([
            key,
            {
              t: "blob",
              size: blobLike.size,
              type: typeof blobLike.type === "string" ? blobLike.type : undefined,
              name: typeof blobLike.name === "string" ? blobLike.name : undefined,
            },
          ]);
          continue;
        }
        entries.push([key, { t: typeof value }]);
      }
      return { t: "formdata", entriesCount: entries.length, entries };
    } catch {
      return { t: "formdata", entriesCount: entries.length };
    }
  }

  return { t: typeof body };
}

function hashPayloadSummary(summary: unknown): { payloadHash?: string; payloadType?: string } {
  if (summary == null) {
    return {};
  }
  try {
    const json = JSON.stringify(summary);
    return {
      payloadHash: sha256Hex(json),
      payloadType: typeof summary === "object" ? "object" : typeof summary,
    };
  } catch {
    return { payloadType: typeof summary };
  }
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch | undefined {
  applyTelegramNetworkWorkarounds(options?.network);

  const base = proxyFetch ? resolveFetch(proxyFetch) : resolveFetch();
  if (!base) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }

  const wrapped: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isTelegramDiagEnabled()) {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (rawUrl && isTelegramApiUrl(rawUrl)) {
        try {
          const url = new URL(rawUrl);
          const method =
            init?.method ??
            (typeof Request !== "undefined" && input instanceof Request
              ? input.method
              : undefined) ??
            "GET";
          const { redacted, apiMethod } = redactTelegramApiPath(url.pathname);
          const delivery = getTelegramDeliveryContext();
          const summary = summarizeFetchBody(init?.body);
          const { payloadHash } = hashPayloadSummary(summary);

          telegramDiagEvent("telegram.http.fetch", {
            deliveryId: delivery?.deliveryId,
            operation: delivery?.operation,
            accountId: delivery?.accountId,
            chatId: delivery?.chatId,
            httpMethod: method,
            apiMethod,
            path: redacted,
            payloadHash,
          });
        } catch {
          // Never let diagnostic logging break sends.
        }
      }
    }

    return base(input, init);
  };

  return wrapped;
}

export function resetTelegramFetchStateForTests(): void {
  appliedAutoSelectFamily = null;
}
