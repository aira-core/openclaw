import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { loadConfig } from "../../config/config.js";
import {
  buildGatewayConnectionDetails,
  ensureExplicitGatewayAuth,
  resolveExplicitGatewayAuth,
  resolveGatewayCredentialsWithSecretInputs,
} from "../../gateway/call.js";
import { GatewayClient } from "../../gateway/client.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "../../gateway/method-scopes.js";
import { isIpInCidr } from "../../shared/net/ip.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { VERSION } from "../../version.js";
import { buildNodeInvokeParams } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export type LoopbackListenSpec = {
  host: "127.0.0.1" | "::1";
  port: number;
};

export type SocksProxyPolicy = {
  allowHosts: string[];
  allowCidrs: string[];
};

type NodeBridgeGatewayClientOptions = Pick<NodesRpcOpts, "url" | "token">;

type StartNodeSocksProxyOptions = NodeBridgeGatewayClientOptions & {
  nodeId: string;
  listen: LoopbackListenSpec;
  policy: SocksProxyPolicy;
  invokeTimeoutMs: number;
  bridgeReadTimeoutMs: number;
  bridgeMaxReadBytes: number;
  onReady?: (info: { host: string; port: number }) => void;
};

type BridgeOpenPayload = {
  bridgeSessionId: string;
};

type BridgeReadPayload = {
  dataBase64?: string;
  eof?: boolean;
};

const SOCKS_VERSION = 0x05;
const SOCKS_METHOD_NO_AUTH = 0x00;
const SOCKS_CMD_CONNECT = 0x01;
const SOCKS_ATYP_IPV4 = 0x01;
const SOCKS_ATYP_DOMAIN = 0x03;
const SOCKS_ATYP_IPV6 = 0x04;
const SOCKS_REPLY_SUCCEEDED = 0x00;
const SOCKS_REPLY_GENERAL_FAILURE = 0x01;
const SOCKS_REPLY_NOT_ALLOWED = 0x02;
const SOCKS_REPLY_COMMAND_NOT_SUPPORTED = 0x07;
const SOCKS_REPLY_ADDRESS_NOT_SUPPORTED = 0x08;

export function parseLoopbackListenSpec(raw: string): LoopbackListenSpec {
  const value = raw.trim();
  if (!value) {
    throw new Error("listen address required");
  }
  const numericOnly = /^\d+$/.test(value);
  if (numericOnly) {
    return { host: "127.0.0.1", port: parsePort(value) };
  }
  if (value.startsWith("[")) {
    const match = value.match(/^\[(.+)]:(\d+)$/);
    if (!match) {
      throw new Error(`invalid listen address: ${raw}`);
    }
    const host = normalizeLoopbackHost(match[1] ?? "");
    return { host, port: parsePort(match[2] ?? "") };
  }
  const parts = value.split(":");
  if (parts.length !== 2) {
    throw new Error(`invalid listen address: ${raw}`);
  }
  const host = normalizeLoopbackHost(parts[0] ?? "");
  return { host, port: parsePort(parts[1] ?? "") };
}

export function isProxyTargetAllowed(host: string, policy: SocksProxyPolicy): boolean {
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost) {
    return false;
  }
  const normalizedAllowHosts = policy.allowHosts.map((entry) => entry.trim().toLowerCase());
  const normalizedAllowCidrs = policy.allowCidrs.map((entry) => entry.trim()).filter(Boolean);
  const literalIp = net.isIP(normalizedHost) !== 0;
  if (literalIp && normalizedAllowCidrs.some((cidr) => isIpInCidr(normalizedHost, cidr))) {
    return true;
  }
  return normalizedAllowHosts.some((rule) => hostRuleMatches(normalizedHost, rule));
}

export async function startNodeSocksProxy(
  opts: StartNodeSocksProxyOptions,
): Promise<{ stop: () => Promise<void>; waitUntilClosed: () => Promise<void> }> {
  if (opts.policy.allowHosts.length === 0 && opts.policy.allowCidrs.length === 0) {
    throw new Error("at least one --allow-host or --allow-cidr rule is required");
  }
  const gateway = await connectGatewayOperatorClient(opts);
  const server = net.createServer((socket) => {
    void handleSocksConnection(socket, {
      gateway,
      nodeId: opts.nodeId,
      policy: opts.policy,
      invokeTimeoutMs: opts.invokeTimeoutMs,
      bridgeReadTimeoutMs: opts.bridgeReadTimeoutMs,
      bridgeMaxReadBytes: opts.bridgeMaxReadBytes,
    }).catch(() => {
      socket.destroy();
    });
  });
  server.on("error", () => {
    void gateway.stop();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.listen.port, opts.listen.host, () => {
      server.off("error", reject);
      opts.onReady?.({ host: opts.listen.host, port: opts.listen.port });
      resolve();
    });
  });
  const closedPromise = once(server, "close").then(() => undefined);
  return {
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await gateway.stop();
    },
    waitUntilClosed: async () => {
      await closedPromise;
      await gateway.stop();
    },
  };
}

async function handleSocksConnection(
  socket: net.Socket,
  params: {
    gateway: ConnectedGatewayClient;
    nodeId: string;
    policy: SocksProxyPolicy;
    invokeTimeoutMs: number;
    bridgeReadTimeoutMs: number;
    bridgeMaxReadBytes: number;
  },
): Promise<void> {
  socket.setNoDelay(true);
  const reader = new BufferedSocketReader(socket);
  let bridgeSessionId: string | null = null;
  try {
    await negotiateSocks5(reader, socket);
    const request = await readSocksConnectRequest(reader);
    if (!isProxyTargetAllowed(request.host, params.policy)) {
      await writeSocksReply(socket, SOCKS_REPLY_NOT_ALLOWED);
      return;
    }
    const opened = await params.gateway.bridgeOpen({
      nodeId: params.nodeId,
      host: request.host,
      port: request.port,
      timeoutMs: params.invokeTimeoutMs,
    });
    bridgeSessionId = opened.bridgeSessionId;
    await writeSocksReply(socket, SOCKS_REPLY_SUCCEEDED);

    const upstreamToClient = (async () => {
      while (!socket.destroyed && bridgeSessionId) {
        const payload = await params.gateway.bridgeRead({
          nodeId: params.nodeId,
          bridgeSessionId,
          timeoutMs: params.invokeTimeoutMs,
          readTimeoutMs: params.bridgeReadTimeoutMs,
          maxBytes: params.bridgeMaxReadBytes,
        });
        const chunk =
          typeof payload.dataBase64 === "string" && payload.dataBase64.length > 0
            ? Buffer.from(payload.dataBase64, "base64")
            : Buffer.alloc(0);
        if (chunk.length > 0) {
          if (!socket.write(chunk)) {
            await once(socket, "drain");
          }
        }
        if (payload.eof) {
          socket.end();
          break;
        }
      }
    })();

    const clientToUpstream = (async () => {
      while (!socket.destroyed && bridgeSessionId) {
        const chunk = await reader.readChunk();
        if (!chunk) {
          await params.gateway.bridgeWrite({
            nodeId: params.nodeId,
            bridgeSessionId,
            timeoutMs: params.invokeTimeoutMs,
            eof: true,
          });
          break;
        }
        if (chunk.length > 0) {
          await params.gateway.bridgeWrite({
            nodeId: params.nodeId,
            bridgeSessionId,
            timeoutMs: params.invokeTimeoutMs,
            data: chunk,
          });
        }
      }
    })();

    await Promise.race([upstreamToClient, clientToUpstream, once(socket, "close")]);
  } catch (err) {
    if (!socket.destroyed) {
      const reply = mapErrorToSocksReply(err);
      try {
        await writeSocksReply(socket, reply);
      } catch {
        socket.destroy();
      }
    }
  } finally {
    if (bridgeSessionId) {
      await params.gateway
        .bridgeClose({
          nodeId: params.nodeId,
          bridgeSessionId,
          timeoutMs: params.invokeTimeoutMs,
        })
        .catch(() => undefined);
    }
    socket.destroy();
    reader.close();
  }
}

async function negotiateSocks5(reader: BufferedSocketReader, socket: net.Socket): Promise<void> {
  const header = await reader.readExactly(2);
  if (header[0] !== SOCKS_VERSION) {
    throw new Error("unsupported SOCKS version");
  }
  const methods = await reader.readExactly(header[1] ?? 0);
  if (!methods.includes(SOCKS_METHOD_NO_AUTH)) {
    socket.write(Buffer.from([SOCKS_VERSION, 0xff]));
    throw new Error("SOCKS client does not support no-auth");
  }
  socket.write(Buffer.from([SOCKS_VERSION, SOCKS_METHOD_NO_AUTH]));
}

async function readSocksConnectRequest(
  reader: BufferedSocketReader,
): Promise<{ host: string; port: number }> {
  const header = await reader.readExactly(4);
  const version = header[0];
  const cmd = header[1];
  const atyp = header[3];
  if (version !== SOCKS_VERSION) {
    throw new Error("invalid SOCKS version");
  }
  if (cmd !== SOCKS_CMD_CONNECT) {
    throw new SocksReplyError(SOCKS_REPLY_COMMAND_NOT_SUPPORTED, "only CONNECT is supported");
  }
  let host: string;
  if (atyp === SOCKS_ATYP_IPV4) {
    const bytes = await reader.readExactly(4);
    host = Array.from(bytes).join(".");
  } else if (atyp === SOCKS_ATYP_DOMAIN) {
    const length = (await reader.readExactly(1))[0] ?? 0;
    host = (await reader.readExactly(length)).toString("utf8");
  } else if (atyp === SOCKS_ATYP_IPV6) {
    const bytes = await reader.readExactly(16);
    host = formatIpv6(bytes);
  } else {
    throw new SocksReplyError(SOCKS_REPLY_ADDRESS_NOT_SUPPORTED, "unsupported address type");
  }
  const portBytes = await reader.readExactly(2);
  const port = portBytes.readUInt16BE(0);
  return { host, port };
}

async function writeSocksReply(socket: net.Socket, replyCode: number): Promise<void> {
  const response = Buffer.from([SOCKS_VERSION, replyCode, 0x00, SOCKS_ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
  if (!socket.write(response)) {
    await once(socket, "drain");
  }
}

function mapErrorToSocksReply(error: unknown): number {
  if (error instanceof SocksReplyError) {
    return error.replyCode;
  }
  const message = String(error).toLowerCase();
  if (message.includes("target_blocked") || message.includes("not allowed")) {
    return SOCKS_REPLY_NOT_ALLOWED;
  }
  if (message.includes("unsupported address")) {
    return SOCKS_REPLY_ADDRESS_NOT_SUPPORTED;
  }
  if (message.includes("connection refused")) {
    return 0x05;
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return 0x06;
  }
  return SOCKS_REPLY_GENERAL_FAILURE;
}

function normalizeLoopbackHost(host: string): "127.0.0.1" | "::1" {
  const normalized = host.trim().toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "localhost") {
    return "127.0.0.1";
  }
  if (normalized === "::1") {
    return "::1";
  }
  throw new Error("listen host must be loopback (127.0.0.1 or ::1)");
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

function hostRuleMatches(host: string, rule: string): boolean {
  if (!rule) {
    return false;
  }
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === rule;
}

function formatIpv6(buffer: Buffer): string {
  const parts: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    parts.push(buffer.readUInt16BE(index).toString(16));
  }
  return parts.join(":");
}

class SocksReplyError extends Error {
  constructor(
    readonly replyCode: number,
    message: string,
  ) {
    super(message);
  }
}

class BufferedSocketReader {
  private readonly buffers: Buffer[] = [];
  private bufferedBytes = 0;
  private ended = false;
  private failure: Error | null = null;
  private pending: Array<{
    kind: "exact" | "chunk";
    size?: number;
    resolve: (value: Buffer | null) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffers.push(chunk);
      this.bufferedBytes += chunk.length;
      this.flush();
    });
    socket.on("end", () => {
      this.ended = true;
      this.flush();
    });
    socket.on("close", () => {
      this.ended = true;
      this.flush();
    });
    socket.on("error", (err) => {
      this.failure = err instanceof Error ? err : new Error(String(err));
      this.flush();
    });
  }

  async readExactly(size: number): Promise<Buffer> {
    if (this.failure) {
      throw this.failure;
    }
    if (this.bufferedBytes >= size) {
      return this.consume(size);
    }
    if (this.ended) {
      throw new Error("unexpected EOF while reading SOCKS handshake");
    }
    return await new Promise<Buffer>((resolve, reject) => {
      this.pending.push({
        kind: "exact",
        size,
        resolve: (value) => resolve(value ?? Buffer.alloc(0)),
        reject,
      });
    });
  }

  async readChunk(): Promise<Buffer | null> {
    if (this.failure) {
      throw this.failure;
    }
    if (this.bufferedBytes > 0) {
      return this.consume(this.bufferedBytes);
    }
    if (this.ended) {
      return null;
    }
    return await new Promise<Buffer | null>((resolve, reject) => {
      this.pending.push({ kind: "chunk", resolve, reject });
    });
  }

  close(): void {
    this.pending.splice(0).forEach((entry) => entry.resolve(null));
  }

  private flush(): void {
    while (this.pending.length > 0) {
      if (this.failure) {
        const error = this.failure;
        this.pending.splice(0).forEach((entry) => entry.reject(error));
        return;
      }
      const next = this.pending[0];
      if (next.kind === "exact") {
        if (this.bufferedBytes >= (next.size ?? 0)) {
          this.pending.shift();
          next.resolve(this.consume(next.size ?? 0));
          continue;
        }
        if (this.ended) {
          this.pending.shift();
          next.reject(new Error("unexpected EOF while reading SOCKS handshake"));
        }
        return;
      }
      if (this.bufferedBytes > 0) {
        this.pending.shift();
        next.resolve(this.consume(this.bufferedBytes));
        continue;
      }
      if (this.ended) {
        this.pending.shift();
        next.resolve(null);
      }
      return;
    }
  }

  private consume(size: number): Buffer {
    const chunks: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      const chunk = this.buffers[0];
      if (!chunk) {
        break;
      }
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        this.buffers.shift();
        this.bufferedBytes -= chunk.length;
        remaining -= chunk.length;
        continue;
      }
      chunks.push(chunk.subarray(0, remaining));
      this.buffers[0] = chunk.subarray(remaining);
      this.bufferedBytes -= remaining;
      remaining = 0;
    }
    return Buffer.concat(chunks, size - remaining);
  }
}

type ConnectedGatewayClient = {
  bridgeOpen: (params: {
    nodeId: string;
    host: string;
    port: number;
    timeoutMs: number;
  }) => Promise<BridgeOpenPayload>;
  bridgeWrite: (params: {
    nodeId: string;
    bridgeSessionId: string;
    timeoutMs: number;
    data?: Buffer;
    eof?: boolean;
  }) => Promise<void>;
  bridgeRead: (params: {
    nodeId: string;
    bridgeSessionId: string;
    timeoutMs: number;
    readTimeoutMs: number;
    maxBytes: number;
  }) => Promise<BridgeReadPayload>;
  bridgeClose: (params: {
    nodeId: string;
    bridgeSessionId: string;
    timeoutMs: number;
  }) => Promise<void>;
  stop: () => Promise<void>;
};

async function connectGatewayOperatorClient(
  opts: NodeBridgeGatewayClientOptions,
): Promise<ConnectedGatewayClient> {
  const config = loadConfig();
  const urlOverride =
    trimToUndefined(opts.url) ?? trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);
  const urlOverrideSource = trimToUndefined(opts.url)
    ? "cli"
    : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL)
      ? "env"
      : undefined;
  const explicitAuth = resolveExplicitGatewayAuth({ token: trimToUndefined(opts.token) });
  const resolvedAuth = await resolveGatewayCredentialsWithSecretInputs({
    config,
    explicitAuth,
    urlOverride,
    urlOverrideSource,
  });
  ensureExplicitGatewayAuth({
    urlOverride,
    urlOverrideSource,
    explicitAuth,
    resolvedAuth,
    errorHint: "Fix: pass --token or configure gateway auth.",
  });
  const connectionDetails = buildGatewayConnectionDetails({
    config,
    url: urlOverride,
    urlSource: urlOverrideSource,
  });
  const remoteSettings = config.gateway?.mode === "remote" ? config.gateway.remote : undefined;
  const tlsFingerprint =
    urlOverrideSource === "cli" ? undefined : trimToUndefined(remoteSettings?.tlsFingerprint);

  const client = await new Promise<GatewayClient>((resolve, reject) => {
    let instance: GatewayClient | undefined;
    const timeout = setTimeout(() => {
      instance?.stop();
      reject(new Error("gateway connect timeout"));
    }, 15_000);
    instance = new GatewayClient({
      url: connectionDetails.url,
      token: resolvedAuth.token,
      password: resolvedAuth.password,
      tlsFingerprint,
      instanceId: randomUUID(),
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientVersion: VERSION,
      mode: GATEWAY_CLIENT_MODES.CLI,
      role: "operator",
      scopes: CLI_DEFAULT_OPERATOR_SCOPES,
      onHelloOk: () => {
        clearTimeout(timeout);
        if (!instance) {
          reject(new Error("gateway client unavailable"));
          return;
        }
        resolve(instance);
      },
      onConnectError: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
      onClose: (_code, reason) => {
        clearTimeout(timeout);
        reject(new Error(reason || "gateway closed during connect"));
      },
    });
    instance.start();
  });

  return {
    bridgeOpen: async ({ nodeId, host, port, timeoutMs }) => {
      const result = await client.request<{ payload?: unknown }>(
        "node.invoke",
        buildNodeInvokeParams({
          nodeId,
          command: "network.bridge.open",
          params: { host, port, connectTimeoutMs: timeoutMs },
          timeoutMs,
        }),
        { timeoutMs },
      );
      const payload = toRecord(result.payload);
      const bridgeSessionId = asNonEmptyString(payload.bridgeSessionId, "missing bridgeSessionId");
      return { bridgeSessionId };
    },
    bridgeWrite: async ({ nodeId, bridgeSessionId, timeoutMs, data, eof }) => {
      await client.request(
        "node.invoke",
        buildNodeInvokeParams({
          nodeId,
          command: "network.bridge.write",
          params: {
            bridgeSessionId,
            dataBase64: data && data.length > 0 ? data.toString("base64") : undefined,
            eof: eof === true ? true : undefined,
          },
          timeoutMs,
        }),
        { timeoutMs },
      );
    },
    bridgeRead: async ({ nodeId, bridgeSessionId, timeoutMs, readTimeoutMs, maxBytes }) => {
      const result = await client.request<{ payload?: unknown }>(
        "node.invoke",
        buildNodeInvokeParams({
          nodeId,
          command: "network.bridge.read",
          params: {
            bridgeSessionId,
            timeoutMs: readTimeoutMs,
            maxBytes,
          },
          timeoutMs: Math.max(timeoutMs, readTimeoutMs + 5_000),
        }),
        { timeoutMs: Math.max(timeoutMs, readTimeoutMs + 5_000) },
      );
      const payload = toRecord(result.payload);
      return {
        dataBase64: typeof payload.dataBase64 === "string" ? payload.dataBase64 : undefined,
        eof: payload.eof === true,
      };
    },
    bridgeClose: async ({ nodeId, bridgeSessionId, timeoutMs }) => {
      await client.request(
        "node.invoke",
        buildNodeInvokeParams({
          nodeId,
          command: "network.bridge.close",
          params: { bridgeSessionId },
          timeoutMs,
        }),
        { timeoutMs },
      );
    },
    stop: async () => {
      client.stop();
    },
  };
}

function trimToUndefined(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNonEmptyString(value: unknown, message: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(message);
}
