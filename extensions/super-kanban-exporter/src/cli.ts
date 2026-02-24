import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { SuperKanbanExporterConfig } from "./config.js";
import {
  coerceSkConfig,
  formatReconcileReportText,
  reconcileSuperKanban,
  type Logger,
  type ReconcileMode,
} from "./reconciler.js";

export function registerSuperKanbanCli(params: {
  program: Command;
  coreConfig: OpenClawConfig;
  resolvedConfig: SuperKanbanExporterConfig;
  logger: Logger;
  resolveStateDir: (env?: NodeJS.ProcessEnv) => string;
}) {
  const cmd = params.program
    .command("super-kanban")
    .description("Super-Kanban integration utilities");

  cmd
    .command("reconcile")
    .description(
      "Scan OpenClaw session transcripts and (optionally) replay idempotent attach/message/tool-call updates to Super-Kanban.",
    )
    .option("--fix", "Send updates to Super-Kanban (default: dry-run)")
    .option("--dry-run", "Do not send; only print what would happen (default)")
    .option("--state-dir <dir>", "Override OpenClaw state dir (default: resolve from env)")
    .option("--agent <agentId>", "Restrict to a single agentId under stateDir/agents")
    .option("--session-id <id>", "Restrict to a single sessionId (transcript basename)")
    .option("--session-key <key>", "Restrict to a single sessionKey (from sessions.json)")
    .option("--max-sessions <n>", "Stop after N matched sessions", (v) => Number(v))
    .option(
      "--preview <n>",
      "Preview up to N events per session (dry-run output)",
      (v) => Number(v),
      3,
    )
    .option("--json", "Output machine-readable JSON")
    // Config overrides
    .option("--base-url <url>", "Override SUPER_KANBAN_BASE_URL")
    .option("--token <token>", "Override SUPER_KANBAN_TOKEN")
    .option("--auth-header <value>", "Override SUPER_KANBAN_AUTH_HEADER (e.g. X-Api-Key: ...) ")
    .option("--attach-path <path>", "Override SUPER_KANBAN_ATTACH_PATH")
    .option("--messages-path <path>", "Override SUPER_KANBAN_MESSAGES_PATH")
    .option("--tool-calls-path <path>", "Override SUPER_KANBAN_TOOL_CALLS_PATH")
    .action(async (opts: any) => {
      const mode: ReconcileMode = opts.fix ? "fix" : "dry-run";
      if (opts.fix && opts.dryRun) {
        throw new Error("Choose either --fix or --dry-run (not both)");
      }

      const stateDir =
        typeof opts.stateDir === "string" && opts.stateDir.trim()
          ? opts.stateDir.trim()
          : params.resolveStateDir(process.env);

      const cfg = coerceSkConfig({
        resolved: params.resolvedConfig,
        overrides: {
          baseUrl: opts.baseUrl,
          token: opts.token,
          authHeader: opts.authHeader,
          attachPath: opts.attachPath,
          messagesPath: opts.messagesPath,
          toolCallsPath: opts.toolCallsPath,
        },
      });

      const report = await reconcileSuperKanban({
        mode,
        filter: {
          stateDir,
          agentId: typeof opts.agent === "string" ? opts.agent.trim() : undefined,
          sessionId: typeof opts.sessionId === "string" ? opts.sessionId.trim() : undefined,
          sessionKey: typeof opts.sessionKey === "string" ? opts.sessionKey.trim() : undefined,
          maxSessions: Number.isFinite(opts.maxSessions)
            ? Math.max(1, opts.maxSessions)
            : undefined,
        },
        cfg,
        coreConfig: params.coreConfig,
        logger: params.logger,
        previewLimit: Number.isFinite(opts.preview) ? Math.max(0, opts.preview) : 3,
      });

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }

      process.stdout.write(formatReconcileReportText(report));

      if (mode === "dry-run") {
        process.stdout.write("\n(dry-run) Re-run with --fix to apply.\n");
      }
    });
}
