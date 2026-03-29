import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runNodesCommand } from "./cli-utils.js";
import { parseLoopbackListenSpec, startNodeSocksProxy } from "./proxy-socks.js";
import { nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

function collectRepeatedValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerNodesProxyCommands(nodes: Command) {
  const proxy = nodes
    .command("proxy")
    .description("Expose loopback-only proxies backed by a paired node");

  nodesCallOpts(
    proxy
      .command("socks")
      .description(
        "Start a local SOCKS5 proxy that opens outbound TCP sockets through an Android node",
      )
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--listen <host:port>", "Loopback listen address", "127.0.0.1:1080")
      .option(
        "--allow-host <host>",
        "Allow an exact host or wildcard suffix (*.example.com)",
        collectRepeatedValue,
        [],
      )
      .option(
        "--allow-cidr <cidr>",
        "Allow a literal IP target in the given CIDR",
        collectRepeatedValue,
        [],
      )
      .option("--invoke-timeout <ms>", "Gateway/node invoke timeout in ms", "20000")
      .option("--bridge-read-timeout <ms>", "Per-read wait on the Android bridge in ms", "2000")
      .option("--bridge-read-max-bytes <n>", "Max bytes per bridge read", "65536")
      .action(
        async (
          opts: NodesRpcOpts & {
            listen?: string;
            allowHost?: string[];
            allowCidr?: string[];
            invokeTimeout?: string;
            bridgeReadTimeout?: string;
            bridgeReadMaxBytes?: string;
          },
        ) => {
          await runNodesCommand("proxy socks", async () => {
            const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
            const listen = parseLoopbackListenSpec(String(opts.listen ?? "127.0.0.1:1080"));
            const invokeTimeoutMs = Number.parseInt(String(opts.invokeTimeout ?? "20000"), 10);
            const bridgeReadTimeoutMs = Number.parseInt(
              String(opts.bridgeReadTimeout ?? "2000"),
              10,
            );
            const bridgeMaxReadBytes = Number.parseInt(
              String(opts.bridgeReadMaxBytes ?? "65536"),
              10,
            );
            const proxyServer = await startNodeSocksProxy({
              url: opts.url,
              token: opts.token,
              nodeId,
              listen,
              policy: {
                allowHosts: Array.isArray(opts.allowHost) ? opts.allowHost : [],
                allowCidrs: Array.isArray(opts.allowCidr) ? opts.allowCidr : [],
              },
              invokeTimeoutMs,
              bridgeReadTimeoutMs,
              bridgeMaxReadBytes,
              onReady: ({ host, port }) => {
                if (!opts.json) {
                  defaultRuntime.log(
                    `SOCKS5 proxy ready on ${host}:${port} via node ${nodeId}. Example: ALL_PROXY=socks5h://${host}:${port}`,
                  );
                } else {
                  defaultRuntime.writeJson({
                    ok: true,
                    type: "socks5",
                    listenHost: host,
                    listenPort: port,
                    nodeId,
                  });
                }
              },
            });
            const shutdown = async () => {
              await proxyServer.stop();
            };
            process.once("SIGINT", () => {
              void shutdown();
            });
            process.once("SIGTERM", () => {
              void shutdown();
            });
            await proxyServer.waitUntilClosed();
          });
        },
      ),
    { timeoutMs: 30_000 },
  );
}
