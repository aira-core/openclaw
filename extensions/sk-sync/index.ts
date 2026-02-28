import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "../../src/plugins/types.js";

type SkSyncConfig = {
  enabled: boolean;
  baseUrl?: string;
  token?: string;
  authHeader?: string;
  timeoutMs: number;
  taskLockTtlSeconds: number;
};

type SkSyncPluginConfig = Partial<{
  enabled: unknown;
  baseUrl: unknown;
  token: unknown;
  authHeader: unknown;
  timeoutMs: unknown;
  taskLockTtlSeconds: unknown;
}>;

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

function parseHeaderLine(value: string): { key: string; value: string } | null {
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const key = value.slice(0, idx).trim();
  const val = value.slice(idx + 1).trim();
  if (!key || !val) return null;
  return { key, value: val };
}

function resolveConfig(pluginConfig: SkSyncPluginConfig, env: NodeJS.ProcessEnv): SkSyncConfig {
  const enabled =
    asBool(pluginConfig.enabled) ??
    asBool(env.SK_SYNC_ENABLED) ??
    asBool(env.OPENCLAW_SK_SYNC_ENABLED) ??
    false;

  const baseUrl = normalizeBaseUrl(
    asString(pluginConfig.baseUrl) ??
      asString(env.SUPER_KANBAN_BASE_URL) ??
      asString(env.OPENCLAW_SUPER_KANBAN_BASE_URL),
  );

  const token =
    asString(pluginConfig.token) ??
    asString(env.SUPER_KANBAN_TOKEN) ??
    asString(env.SUPER_KANBAN_API_KEY) ??
    asString(env.OPENCLAW_SUPER_KANBAN_TOKEN);

  const authHeader =
    asString(pluginConfig.authHeader) ??
    asString(env.SUPER_KANBAN_AUTH_HEADER) ??
    asString(env.OPENCLAW_SUPER_KANBAN_AUTH_HEADER);

  const timeoutMs = Math.max(500, Math.floor(asNumber(pluginConfig.timeoutMs) ?? 10_000));
  const taskLockTtlSeconds = Math.max(
    60,
    Math.floor(asNumber(pluginConfig.taskLockTtlSeconds) ?? 3600),
  );

  return {
    enabled,
    baseUrl,
    token,
    authHeader,
    timeoutMs,
    taskLockTtlSeconds,
  };
}

type SkSessionSummary = {
  id: string;
  entityType: "PROJECT" | "WORK_ITEM" | "TASK";
  entityId: string;
  sessionKey: string;
  state: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  createdAt: string;
  updatedAt: string;
};

type SkClientOpts = {
  baseUrl: string;
  token?: string;
  authHeader?: string;
  timeoutMs: number;
};

class SkClient {
  #opts: SkClientOpts;
  constructor(opts: SkClientOpts) {
    this.#opts = opts;
  }

  headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    const explicit = this.#opts.authHeader?.trim();
    if (explicit) {
      const parsed = parseHeaderLine(explicit);
      if (parsed) headers[parsed.key] = parsed.value;
      return headers;
    }
    const token = this.#opts.token?.trim();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async requestJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.#opts.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#opts.timeoutMs);
    try {
      const headers = this.headers();
      if (init.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const res = await fetch(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const details = json?.error ?? json?.message ?? text ?? `HTTP ${res.status}`;
        const err = new Error(`Super-Kanban API error: ${res.status} ${details}`);
        (err as any).status = res.status;
        (err as any).body = json;
        throw err;
      }
      return json as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async upsertProject(input: {
    externalId: string;
    name: string;
    projectRootPath?: string | null;
  }): Promise<{ id: string; externalId: string | null }> {
    const res = await this.requestJson<{
      data: { item: { id: string; externalId: string | null } };
    }>("/integrations/openclaw/projects/upsert", {
      method: "POST",
      body: {
        externalId: input.externalId,
        name: input.name,
        mode: "OPENCLAW_MODE",
        projectRootPath: input.projectRootPath ?? undefined,
      },
    });
    return res.data.item;
  }

  async upsertWorkItem(input: {
    externalId: string;
    projectId: string;
    title: string;
    description?: string | null;
    status: string;
  }): Promise<{ id: string; externalId: string | null }> {
    const res = await this.requestJson<{
      data: { item: { id: string; externalId: string | null } };
    }>("/integrations/openclaw/work-items/upsert", {
      method: "POST",
      body: {
        externalId: input.externalId,
        projectId: input.projectId,
        title: input.title,
        description: input.description ?? undefined,
        status: input.status,
      },
    });
    return res.data.item;
  }

  async upsertTask(input: {
    externalId: string;
    projectId: string;
    workItemId: string;
    title: string;
    description?: string | null;
    status: string;
  }): Promise<{ id: string; externalId: string | null }> {
    const res = await this.requestJson<{
      data: { item: { id: string; externalId: string | null } };
    }>("/integrations/openclaw/tasks/upsert", {
      method: "POST",
      body: {
        externalId: input.externalId,
        projectId: input.projectId,
        workItemId: input.workItemId,
        title: input.title,
        description: input.description ?? undefined,
        status: input.status,
      },
    });
    return res.data.item;
  }

  async attachSession(input: {
    entityType: "PROJECT" | "WORK_ITEM" | "TASK";
    entityId: string;
    sessionKey: string;
    state: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
    runId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
  }): Promise<void> {
    await this.requestJson("/integrations/openclaw/sessions/attach", {
      method: "POST",
      body: {
        entityType: input.entityType,
        entityId: input.entityId,
        sessionKey: input.sessionKey,
        state: input.state,
        runId: input.runId ?? undefined,
        startedAt: input.startedAt ?? undefined,
        endedAt: input.endedAt ?? undefined,
      },
    });
  }

  async resolveSessionBySessionKey(sessionKey: string): Promise<{
    entityType: "PROJECT" | "WORK_ITEM" | "TASK";
    entityId: string;
    sessionId: string;
    state: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  } | null> {
    try {
      const res = await this.requestJson<{
        data: {
          entityType: "PROJECT" | "WORK_ITEM" | "TASK";
          entityId: string;
          sessionId: string;
          state: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
        };
      }>(`/sessions/resolve?sessionKey=${encodeURIComponent(sessionKey)}`);
      return res.data;
    } catch (err) {
      const status = (err as any)?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async listProjectSessions(projectId: string): Promise<SkSessionSummary[]> {
    const res = await this.requestJson<{ data: { items: SkSessionSummary[] } }>(
      `/projects/${encodeURIComponent(projectId)}/sessions?limit=50`,
    );
    return res.data.items;
  }

  async listWorkItemSessions(workItemId: string): Promise<SkSessionSummary[]> {
    const res = await this.requestJson<{ data: { items: SkSessionSummary[] } }>(
      `/work-items/${encodeURIComponent(workItemId)}/sessions?limit=50`,
    );
    return res.data.items;
  }

  async lockTask(input: { taskId: string; owner: string; ttlSeconds: number }): Promise<void> {
    await this.requestJson(`/tasks/${encodeURIComponent(input.taskId)}/lock`, {
      method: "POST",
      body: { owner: input.owner, ttlSeconds: input.ttlSeconds },
    });
  }

  async unlockTask(input: { taskId: string; owner: string }): Promise<void> {
    await this.requestJson(`/tasks/${encodeURIComponent(input.taskId)}/unlock`, {
      method: "POST",
      body: { owner: input.owner },
    });
  }

  async patchTaskStatus(input: { taskId: string; status: string }): Promise<void> {
    await this.requestJson(`/tasks/${encodeURIComponent(input.taskId)}`, {
      method: "PATCH",
      body: { status: input.status },
    });
  }
}

const SkSyncSpawnSchema = {
  type: "object",
  additionalProperties: false,
  required: ["level", "task", "projectExternalId"],
  properties: {
    level: { type: "string", enum: ["ORION", "ATLAS", "WORKER"] },

    task: {
      type: "string",
      description:
        "Prompt to send into the session (reuse) or task description for a new spawned session.",
    },

    label: { type: "string" },

    // Entity keys
    projectExternalId: { type: "string" },
    projectName: { type: "string" },
    projectRootPath: { type: "string" },

    workItemExternalId: { type: "string" },
    workItemTitle: { type: "string" },
    workItemDescription: { type: "string" },

    taskExternalId: { type: "string" },
    taskTitle: { type: "string" },
    taskDescription: { type: "string" },

    // Spawn params passthrough
    agentId: { type: "string" },
    wakeParentOnEnd: {
      type: "boolean",
      default: true,
      description:
        "If true, send an internal sessions_send to the parent session when the spawned subagent run ends (best-effort). Default: true (opt-out with false).",
    },
    model: { type: "string" },
    thinking: { type: "string" },
    cwd: { type: "string" },
    runTimeoutSeconds: { type: "number", minimum: 0 },
  },
} as const;

type SkSyncSpawnArgs = {
  level: "ORION" | "ATLAS" | "WORKER";
  task: string;
  label?: string;

  projectExternalId: string;
  projectName?: string;
  projectRootPath?: string;

  workItemExternalId?: string;
  workItemTitle?: string;
  workItemDescription?: string;

  taskExternalId?: string;
  taskTitle?: string;
  taskDescription?: string;

  agentId?: string;
  wakeParentOnEnd?: boolean;
  model?: string;
  thinking?: string;
  cwd?: string;
  runTimeoutSeconds?: number;
};

export function resolveWakeParentOnEnd(value?: boolean): boolean {
  // Default is true; opt-out via explicit false.
  return value !== false;
}

type WakeParentOnEndEntry = {
  parentSessionKey: string;
  childSessionKey: string;
  wakeParentOnEnd: boolean;
};

export function createWakeParentOnEndTracker(params: { logger: { warn: (msg: string) => void } }): {
  setSessionsSend: (
    fn: NonNullable<NonNullable<OpenClawPluginToolContext["openclaw"]>["sessionsSend"]>,
  ) => void;
  trackSpawn: (input: {
    runId: string | null;
    parentSessionKey: string | null;
    childSessionKey: string;
    wakeParentOnEnd?: boolean;
  }) => void;
  handleSubagentEnded: (input: { runId?: string | null; outcome?: string }) => Promise<void>;
} {
  const entriesByRunId = new Map<string, WakeParentOnEndEntry>();
  let sessionsSend: NonNullable<
    NonNullable<OpenClawPluginToolContext["openclaw"]>["sessionsSend"]
  > | null = null;

  function setSessionsSend(
    fn: NonNullable<NonNullable<OpenClawPluginToolContext["openclaw"]>["sessionsSend"]>,
  ) {
    // Best-effort: capture once, then reuse for hook-driven sends.
    if (!sessionsSend) sessionsSend = fn;
  }

  function trackSpawn(input: {
    runId: string | null;
    parentSessionKey: string | null;
    childSessionKey: string;
    wakeParentOnEnd?: boolean;
  }) {
    if (!resolveWakeParentOnEnd(input.wakeParentOnEnd)) return;
    if (!input.runId) return;
    if (!input.parentSessionKey) return;

    entriesByRunId.set(input.runId, {
      parentSessionKey: input.parentSessionKey,
      childSessionKey: input.childSessionKey,
      wakeParentOnEnd: true,
    });
  }

  async function handleSubagentEnded(input: { runId?: string | null; outcome?: string }) {
    const runId = input.runId ?? null;
    if (!runId) return;

    const entry = entriesByRunId.get(runId);
    if (!entry?.wakeParentOnEnd) return;

    // Ensure one wake per runId, even if hooks fire multiple times.
    entriesByRunId.delete(runId);

    if (!sessionsSend) {
      params.logger.warn(
        "[sk-sync] wakeParentOnEnd: sessionsSend is not available (tool was never invoked?)",
      );
      return;
    }

    try {
      await sessionsSend({
        sessionKey: entry.parentSessionKey,
        timeoutSeconds: 0,
        message: JSON.stringify({
          type: "sk_sync_wake_parent_on_end",
          status: "ended",
          runId,
          childSessionKey: entry.childSessionKey,
          outcome: input.outcome ?? null,
        }),
      });
    } catch (err) {
      params.logger.warn("[sk-sync] wakeParentOnEnd: sessions_send failed: " + String(err));
    }
  }

  return { setSessionsSend, trackSpawn, handleSubagentEnded };
}

function requireOpenclawSessionApi(ctx: OpenClawPluginToolContext): {
  sessionsSpawn: NonNullable<NonNullable<OpenClawPluginToolContext["openclaw"]>["sessionsSpawn"]>;
  sessionsSend: NonNullable<NonNullable<OpenClawPluginToolContext["openclaw"]>["sessionsSend"]>;
} {
  const spawn = ctx.openclaw?.sessionsSpawn;
  const send = ctx.openclaw?.sessionsSend;
  if (!spawn || !send) {
    throw new Error(
      "Plugin tool context is missing ctx.openclaw.sessionsSpawn/sessionsSend. Update OpenClaw core to expose plugin session helpers.",
    );
  }
  return { sessionsSpawn: spawn, sessionsSend: send };
}

function firstSessionKey(sessions: SkSessionSummary[]): string | null {
  // Prefer a RUNNING session; otherwise fall back to the most recent one.
  const running = sessions.find((s) => s.state === "RUNNING");
  if (running?.sessionKey) return running.sessionKey;
  const first = sessions[0];
  return first?.sessionKey ?? null;
}

function mapOutcomeToTaskStatus(outcome?: string): {
  state: SkSessionSummary["state"];
  task: string;
} {
  if (outcome === "ok") return { state: "DONE", task: "DONE" };
  if (outcome === "timeout") return { state: "FAILED", task: "BLOCKED" };
  if (outcome === "error") return { state: "FAILED", task: "BLOCKED" };
  if (outcome === "killed" || outcome === "reset" || outcome === "deleted") {
    return { state: "CANCELLED", task: "CANCELLED" };
  }
  // Conservative default
  return { state: "FAILED", task: "BLOCKED" };
}

function mapOutcomeToSessionState(outcome?: string): SkSessionSummary["state"] {
  if (outcome === "ok") return "DONE";
  if (outcome === "timeout") return "FAILED";
  if (outcome === "error") return "FAILED";
  if (outcome === "killed" || outcome === "reset" || outcome === "deleted") return "CANCELLED";
  // Conservative default
  return "FAILED";
}

const skSyncConfigSchema = {
  parse(value: unknown): SkSyncPluginConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as SkSyncPluginConfig;
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      baseUrl: { type: "string" },
      token: { type: "string" },
      authHeader: { type: "string" },
      timeoutMs: { type: "number" },
      taskLockTtlSeconds: { type: "number" },
    },
  },
};

function createSkSyncSpawnTool(params: {
  config: SkSyncConfig;
  sk: SkClient;
  onChildSession?: (childSessionKey: string, requesterSessionKey: string) => void;
  wakeParentOnEndTracker?: ReturnType<typeof createWakeParentOnEndTracker>;
}): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (ctx) => {
    const { sessionsSpawn, sessionsSend } = requireOpenclawSessionApi(ctx);
    params.wakeParentOnEndTracker?.setSessionsSend(sessionsSend);

    return {
      name: "sk_sync_spawn_plugin",
      label: "SK-Sync Spawn (plugin)",
      description:
        "Create/upsert Super-Kanban entities (by OPENCLAW externalId), attach sessions, and spawn/reuse OpenClaw sessions.",
      parameters: SkSyncSpawnSchema,
      execute: async (_toolCallId, raw) => {
        if (!params.config.enabled) {
          return {
            content: [{ type: "text", text: JSON.stringify({ status: "disabled" }, null, 2) }],
            details: { status: "disabled" },
          };
        }
        if (!params.config.baseUrl) {
          throw new Error("SK-Sync requires baseUrl (SUPER_KANBAN_BASE_URL or plugin config)");
        }

        const args = raw as SkSyncSpawnArgs;
        const nowIso = new Date().toISOString();

        // Ensure entities
        const project = await params.sk.upsertProject({
          externalId: args.projectExternalId,
          name: args.projectName ?? args.projectExternalId,
          projectRootPath: args.projectRootPath ?? null,
        });

        let workItem: { id: string; externalId: string | null } | null = null;
        let taskEntity: { id: string; externalId: string | null } | null = null;

        if (args.level === "ATLAS" || args.level === "WORKER") {
          if (!args.workItemExternalId) {
            throw new Error("workItemExternalId is required for level=ATLAS|WORKER");
          }
          workItem = await params.sk.upsertWorkItem({
            externalId: args.workItemExternalId,
            projectId: project.id,
            title: args.workItemTitle ?? args.workItemExternalId,
            description: args.workItemDescription ?? null,
            status: "IN_PROGRESS",
          });
        }

        if (args.level === "WORKER") {
          if (!args.taskExternalId) {
            throw new Error("taskExternalId is required for level=WORKER");
          }
          if (!workItem) {
            throw new Error("internal error: workItem must be resolved for level=WORKER");
          }
          taskEntity = await params.sk.upsertTask({
            externalId: args.taskExternalId,
            projectId: project.id,
            workItemId: workItem.id,
            title: args.taskTitle ?? args.taskExternalId,
            description: args.taskDescription ?? null,
            status: "IN_PROGRESS",
          });
        }

        // Decide entity binding
        const entityType =
          args.level === "ORION" ? "PROJECT" : args.level === "ATLAS" ? "WORK_ITEM" : "TASK";
        const entityId =
          args.level === "ORION"
            ? project.id
            : args.level === "ATLAS"
              ? workItem!.id
              : taskEntity!.id;

        // WORKER: acquire lock before spawning
        if (args.level === "WORKER") {
          const owner = ctx.sessionKey;
          if (!owner) {
            throw new Error("WORKER mode requires ctx.sessionKey to own the task lock");
          }
          try {
            await params.sk.lockTask({
              taskId: entityId,
              owner,
              ttlSeconds: params.config.taskLockTtlSeconds,
            });
          } catch (err: any) {
            // If the task is already locked, return a structured conflict instead of a generic tool_error.
            const msg = typeof err?.message === "string" ? err.message : String(err);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ status: "conflict", reason: "task_locked" }, null, 2),
                },
              ],
              details: {
                status: "conflict",
                reason: "task_locked",
                entityType,
                entityId,
                message: msg,
              },
            };
          }
        }

        // ORION/ATLAS: reuse the most recent sessionKey when present.
        if (args.level !== "WORKER") {
          const sessions =
            entityType === "PROJECT"
              ? await params.sk.listProjectSessions(entityId)
              : await params.sk.listWorkItemSessions(entityId);
          const existingSessionKey = firstSessionKey(sessions);
          if (existingSessionKey) {
            // Keep session state RUNNING for persistent logical sessions.
            await params.sk.attachSession({
              entityType,
              entityId,
              sessionKey: existingSessionKey,
              state: "RUNNING",
              startedAt: nowIso,
            });
            const sendRes = await sessionsSend({
              sessionKey: existingSessionKey,
              message: args.task,
            });
            return {
              content: [
                { type: "text", text: JSON.stringify({ status: "ok", action: "reused" }, null, 2) },
              ],
              details: {
                status: "ok",
                action: "reused",
                entityType,
                entityId,
                sessionKey: existingSessionKey,
                send: sendRes,
              },
            };
          }
        }

        // Spawn new session
        const spawnRes = await sessionsSpawn({
          task: args.task,
          label: args.label,
          agentId: args.agentId,
          model: args.model,
          thinking: args.thinking,
          cwd: args.cwd,
          runTimeoutSeconds: args.runTimeoutSeconds,
          mode: "run",
          cleanup: "keep",
        });

        const status =
          typeof (spawnRes as any)?.status === "string" ? (spawnRes as any).status : "error";
        // sessions_spawn returns status="accepted" on success.
        const ok = status === "accepted" || status === "ok";
        if (!ok) {
          // If worker spawn failed, best-effort unlock.
          if (args.level === "WORKER") {
            const owner = ctx.sessionKey;
            if (owner) {
              try {
                await params.sk.unlockTask({ taskId: entityId, owner });
              } catch {
                // ignore
              }
            }
          }

          return {
            content: [{ type: "text", text: JSON.stringify(spawnRes, null, 2) }],
            details: spawnRes,
          };
        }

        const childSessionKey = String(
          (spawnRes as any).childSessionKey ?? (spawnRes as any).sessionKey ?? "",
        );
        const runId = (spawnRes as any).runId ? String((spawnRes as any).runId) : null;

        params.wakeParentOnEndTracker?.trackSpawn({
          runId,
          parentSessionKey: ctx.sessionKey ?? null,
          childSessionKey,
          wakeParentOnEnd: args.wakeParentOnEnd,
        });

        if (childSessionKey && ctx.sessionKey) {
          params.onChildSession?.(childSessionKey, ctx.sessionKey);
        }

        await params.sk.attachSession({
          entityType,
          entityId,
          sessionKey: childSessionKey,
          state: "RUNNING",
          runId,
          startedAt: nowIso,
        });

        return {
          content: [
            { type: "text", text: JSON.stringify({ status: "ok", action: "spawned" }, null, 2) },
          ],
          details: {
            status: "ok",
            action: "spawned",
            entityType,
            entityId,
            sessionKey: childSessionKey,
            spawn: spawnRes,
          },
        };
      },
    } satisfies AnyAgentTool;
  };
}

const plugin = {
  id: "sk-sync",
  name: "SK-Sync",
  description: "SK-Sync: Super-Kanban-driven session spawning + lifecycle sync",
  configSchema: skSyncConfigSchema,
  register(api: OpenClawPluginApi) {
    const parsed = skSyncConfigSchema.parse(api.pluginConfig);
    const config = resolveConfig(parsed, process.env);

    if (!config.enabled) {
      api.logger.info("[sk-sync] disabled");
      return;
    }

    if (!config.baseUrl) {
      api.logger.warn("[sk-sync] enabled but missing baseUrl (SUPER_KANBAN_BASE_URL)");
      return;
    }

    const sk = new SkClient({
      baseUrl: config.baseUrl,
      token: config.token,
      authHeader: config.authHeader,
      timeoutMs: config.timeoutMs,
    });

    // We need the requester sessionKey for TASK unlock in fast-path hooks.
    const requesterSessionKeyByChild = new Map<string, string>();
    const wakeParentOnEndTracker = createWakeParentOnEndTracker({ logger: api.logger });

    api.registerTool(
      createSkSyncSpawnTool({
        config,
        sk,
        onChildSession: (childSessionKey, requesterSessionKey) => {
          requesterSessionKeyByChild.set(childSessionKey, requesterSessionKey);
        },
        wakeParentOnEndTracker,
      }),
    );

    api.on("subagent_spawned", async (event, hookCtx) => {
      try {
        const childSessionKey = String(
          (event as any)?.childSessionKey ??
            (event as any)?.sessionKey ??
            (event as any)?.targetSessionKey ??
            "",
        );
        const requesterSessionKey = (hookCtx as any)?.requesterSessionKey;
        if (childSessionKey && requesterSessionKey) {
          requesterSessionKeyByChild.set(childSessionKey, requesterSessionKey);
        }
      } catch (err) {
        api.logger.warn(`[sk-sync] subagent_spawned hook failed: ${String(err)}`);
      }
    });

    async function closeExecutionSession(input: {
      sessionKey: string;
      outcome?: string;
      requesterSessionKey?: string | null;
      source: "agent_end" | "subagent_ended";
    }): Promise<void> {
      const resolved = await sk.resolveSessionBySessionKey(input.sessionKey);
      if (!resolved) return;

      // If it's already terminal, avoid duplicate SESSION_ENDED timeline events.
      if (resolved.state !== "RUNNING") {
        // Still best-effort reconcile TASK status/lock.
        if (resolved.entityType === "TASK") {
          const mapped = mapOutcomeToTaskStatus(input.outcome);
          try {
            await sk.patchTaskStatus({ taskId: resolved.entityId, status: mapped.task });
          } catch {
            // ignore
          }
          const owner =
            input.requesterSessionKey ?? requesterSessionKeyByChild.get(input.sessionKey) ?? null;
          if (owner) {
            try {
              await sk.unlockTask({ taskId: resolved.entityId, owner });
            } catch {
              // ignore
            }
          }
        }
        requesterSessionKeyByChild.delete(input.sessionKey);
        return;
      }

      const nowIso = new Date().toISOString();

      if (resolved.entityType === "TASK") {
        const mapped = mapOutcomeToTaskStatus(input.outcome);

        await sk.attachSession({
          entityType: resolved.entityType,
          entityId: resolved.entityId,
          sessionKey: input.sessionKey,
          state: mapped.state,
          endedAt: nowIso,
        });

        // Derive task status from the run outcome.
        await sk.patchTaskStatus({ taskId: resolved.entityId, status: mapped.task });

        const owner =
          input.requesterSessionKey ?? requesterSessionKeyByChild.get(input.sessionKey) ?? null;
        if (owner) {
          try {
            await sk.unlockTask({ taskId: resolved.entityId, owner });
          } catch {
            // ignore unlock errors (idempotent / possible TTL expiry)
          }
        }

        requesterSessionKeyByChild.delete(input.sessionKey);
        return;
      }

      // PROJECT / WORK_ITEM: close the execution session with a terminal state.
      await sk.attachSession({
        entityType: resolved.entityType,
        entityId: resolved.entityId,
        sessionKey: input.sessionKey,
        state: mapOutcomeToSessionState(input.outcome),
        endedAt: nowIso,
      });

      requesterSessionKeyByChild.delete(input.sessionKey);
    }

    // Fast-path: agent_end fires when a run ends, without waiting for the announcement pipeline.
    api.on("agent_end", async (event, hookCtx) => {
      try {
        const sessionKey = String(
          (hookCtx as any)?.sessionKey ??
            (event as any)?.sessionKey ??
            (event as any)?.targetSessionKey ??
            "",
        );
        if (!sessionKey) return;

        // Only handle runs we spawned/tracked; avoid closing requester sessions on every agent turn.
        if (!requesterSessionKeyByChild.has(sessionKey)) return;

        const eventAny = event as any;
        let outcome: string | undefined = eventAny?.outcome;
        if (!outcome) {
          if (eventAny?.success === true) {
            outcome = "ok";
          } else if (eventAny?.success === false) {
            const errText =
              typeof eventAny?.error === "string" ? String(eventAny.error).toLowerCase() : "";
            outcome = errText.includes("timeout") ? "timeout" : "error";
          }
        }

        await closeExecutionSession({
          sessionKey,
          outcome,
          requesterSessionKey: requesterSessionKeyByChild.get(sessionKey) ?? null,
          source: "agent_end",
        });
      } catch (err) {
        api.logger.warn(`[sk-sync] agent_end hook failed: ${String(err)}`);
      }
    });

    // Fallback: subagent_ended can be delayed (announcement pipeline). Keep it for safety.
    api.on("subagent_ended", async (event, hookCtx) => {
      try {
        const sessionKey = String((event as any)?.targetSessionKey ?? "");
        if (!sessionKey) return;

        await closeExecutionSession({
          sessionKey,
          outcome: (event as any)?.outcome,
          requesterSessionKey: (hookCtx as any)?.requesterSessionKey ?? null,
          source: "subagent_ended",
        });

        await wakeParentOnEndTracker.handleSubagentEnded({
          runId: (event as any)?.runId ?? (hookCtx as any)?.runId ?? null,
          outcome: (event as any)?.outcome,
        });
      } catch (err) {
        api.logger.warn(`[sk-sync] subagent_ended hook failed: ${String(err)}`);
      }
    });

    api.logger.info(
      "[sk-sync] registered tool sk_sync_spawn_plugin + agent_end/subagent_spawned/subagent_ended hooks",
    );
  },
};

export default plugin;
