import { createHash } from "node:crypto";
import { callGateway, randomIdempotencyKey } from "../../src/gateway/call.js";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "../../src/plugins/types.js";

type SkSyncConfig = {
  enabled: boolean;

  /**
   * Super-Kanban base URL.
   *
   * Accepted forms:
   * - http(s)://host/super-kanban
   * - http(s)://host/super-kanban/api
   * - http(s)://host/super-kanban/api/integrations/openclaw
   *
   * Normalized to end with `/api`.
   */
  baseUrl?: string;

  /** READ_UI token (preferred). Sent as `Authorization: Bearer <token>` for read endpoints. */
  bearerToken?: string;

  /** WRITE_INTEGRATION token (preferred). Sent as `x-api-key: <key>` for write endpoints. */
  apiKey?: string;

  /** Legacy combined token (back-compat). */
  token?: string;

  /** Legacy auth header (back-compat). Value must be `Header-Name: value`. */
  authHeader?: string;

  /** Optional overrides per auth scope. Value must be `Header-Name: value`. */
  authHeaderRead?: string;
  authHeaderWrite?: string;

  timeoutMs: number;
  taskLockTtlSeconds: number;
};

type SkSyncPluginConfig = Partial<{
  enabled: unknown;
  baseUrl: unknown;

  bearerToken: unknown;
  apiKey: unknown;

  token: unknown;
  authHeader: unknown;

  authHeaderRead: unknown;
  authHeaderWrite: unknown;

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
  let trimmed = value?.trim();
  if (!trimmed) return undefined;

  // Trim trailing slashes.
  trimmed = trimmed.replace(/\/+$/, "");

  // Be forgiving: allow passing either root (/super-kanban) or /api or /api/integrations/openclaw.
  // We normalize everything to a base URL ending in /api.
  trimmed = trimmed.replace(/\/api\/integrations\/openclaw$/i, "");
  trimmed = trimmed.replace(/\/api$/i, "");

  return trimmed + "/api";
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
      asString(env.SUPERKANBAN_BASE_URL) ??
      asString(env.SUPER_KANBAN_BASE_URL) ??
      asString(env.OPENCLAW_SUPER_KANBAN_BASE_URL) ??
      asString(env.BASE_URL),
  );

  // Preferred split auth (read vs write)
  const bearerToken =
    asString(pluginConfig.bearerToken) ??
    asString(env.SUPERKANBAN_BEARER_TOKEN) ??
    asString(env.SUPER_KANBAN_BEARER_TOKEN);

  const apiKey =
    asString(pluginConfig.apiKey) ??
    asString(env.SUPERKANBAN_API_KEY) ??
    asString(env.SUPER_KANBAN_API_KEY) ??
    // legacy envs used in older setups
    asString(env.SUPER_KANBAN_TOKEN);

  // Legacy combined token/authHeader (back-compat)
  const token =
    asString(pluginConfig.token) ??
    asString(env.SUPER_KANBAN_TOKEN) ??
    asString(env.SUPER_KANBAN_API_KEY) ??
    asString(env.OPENCLAW_SUPER_KANBAN_TOKEN);

  // Legacy authHeader is a global knob (often set to x-api-key). If split auth is configured,
  // we intentionally do NOT inherit this env var for READ endpoints.
  const authHeaderExplicit = asString(pluginConfig.authHeader);
  const authHeader =
    authHeaderExplicit ??
    (!bearerToken && !apiKey
      ? (asString(env.SUPER_KANBAN_AUTH_HEADER) ?? asString(env.OPENCLAW_SUPER_KANBAN_AUTH_HEADER))
      : undefined);

  const authHeaderRead =
    asString(pluginConfig.authHeaderRead) ??
    asString(env.SUPERKANBAN_AUTH_HEADER_READ) ??
    asString(env.SUPER_KANBAN_AUTH_HEADER_READ);

  const authHeaderWrite =
    asString(pluginConfig.authHeaderWrite) ??
    asString(env.SUPERKANBAN_AUTH_HEADER_WRITE) ??
    asString(env.SUPER_KANBAN_AUTH_HEADER_WRITE);

  const timeoutMs = Math.max(500, Math.floor(asNumber(pluginConfig.timeoutMs) ?? 10_000));
  const taskLockTtlSeconds = Math.max(
    60,
    Math.floor(asNumber(pluginConfig.taskLockTtlSeconds) ?? 3600),
  );

  return {
    enabled,
    baseUrl,
    bearerToken,
    apiKey,
    token,
    authHeader,
    authHeaderRead,
    authHeaderWrite,
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

  // Preferred split auth
  bearerToken?: string;
  apiKey?: string;

  // Legacy
  token?: string;
  authHeader?: string;
  authHeaderRead?: string;
  authHeaderWrite?: string;

  timeoutMs: number;
};

type SkAuthMode = "read" | "write" | "auto";

type SkProject = {
  id: string;
  name: string;
  mode: string;
  projectPath: string;
  manualVerificationEnabled: boolean;
  isArchived: boolean;
  externalSystem: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
};

type SkWorkItem = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  pipelineStepKey: string | null;
  position: number;
  isArchived: boolean;
  externalSystem: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
};

type SkTask = {
  id: string;
  projectId: string;
  workItemId: string | null;
  title: string;
  description: string | null;
  status: string;
  position: number;
  isArchived: boolean;
  externalSystem: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
};

export class SkClient {
  #opts: SkClientOpts;
  constructor(opts: SkClientOpts) {
    this.#opts = opts;
  }

  headers(mode: Exclude<SkAuthMode, "auto">): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };

    const explicit = (
      mode === "read"
        ? (this.#opts.authHeaderRead ?? this.#opts.authHeader)?.trim()
        : (this.#opts.authHeaderWrite ?? this.#opts.authHeader)?.trim()
    )?.trim();

    if (explicit) {
      const parsed = parseHeaderLine(explicit);
      if (!parsed) throw new Error("Invalid authHeader: " + JSON.stringify(explicit));
      headers[parsed.key] = parsed.value;
      return headers;
    }

    const bearer = (this.#opts.bearerToken ?? this.#opts.token)?.trim();
    const apiKey = (this.#opts.apiKey ?? this.#opts.token)?.trim();

    if (mode === "read") {
      if (bearer) {
        headers.authorization = "Bearer " + bearer;
        return headers;
      }
      if (apiKey) {
        headers["x-api-key"] = apiKey;
        return headers;
      }
    } else {
      if (apiKey) {
        headers["x-api-key"] = apiKey;
        return headers;
      }
      if (bearer) {
        headers.authorization = "Bearer " + bearer;
        return headers;
      }
    }

    throw new Error(
      "Missing Super-Kanban auth. Provide bearerToken (READ_UI) and/or apiKey (WRITE_INTEGRATION).",
    );
  }

  async requestJson<T>(
    path: string,
    init: { method?: string; body?: unknown; auth?: SkAuthMode } = {},
  ): Promise<T> {
    const p = path.startsWith("/") ? path : "/" + path;
    const url = this.#opts.baseUrl + p;

    const method = String(init.method ?? "GET").toUpperCase();
    const wantsWrite = !["GET", "HEAD", "OPTIONS"].includes(method);

    const authMode: Exclude<SkAuthMode, "auto"> =
      init.auth && init.auth !== "auto" ? init.auth : wantsWrite ? "write" : "read";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#opts.timeoutMs);
    try {
      const headers = this.headers(authMode);
      if (init.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const res = await fetch(url, {
        method,
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
        const details = json?.error ?? json?.message ?? text ?? "HTTP " + res.status;
        const err = new Error("Super-Kanban API error: " + res.status + " " + String(details));
        (err as any).status = res.status;
        (err as any).body = json;
        throw err;
      }
      return json as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // READ UI endpoints
  async listProjects(input: { includeArchived?: boolean } = {}): Promise<SkProject[]> {
    const inc = input.includeArchived ?? false;
    const res = await this.requestJson<{ data: { items: SkProject[] } }>(
      "/projects?includeArchived=" + (inc ? "true" : "false"),
      { auth: "read" },
    );
    return res.data.items;
  }

  async listWorkItemsByProjectId(input: {
    projectId: string;
    includeArchived?: boolean;
    status?: string;
  }): Promise<SkWorkItem[]> {
    const inc = input.includeArchived ?? false;
    const q = new URLSearchParams({
      includeArchived: inc ? "true" : "false",
    });
    if (input.status) q.set("status", input.status);
    const res = await this.requestJson<{ data: { items: SkWorkItem[] } }>(
      "/projects/" + encodeURIComponent(input.projectId) + "/work-items?" + q.toString(),
      { auth: "read" },
    );
    return res.data.items;
  }

  async listTasksByWorkItemId(input: {
    workItemId: string;
    includeArchived?: boolean;
    status?: string;
  }): Promise<SkTask[]> {
    const inc = input.includeArchived ?? false;
    const res = await this.requestJson<{ data: { items: SkTask[] } }>(
      "/work-items/" +
        encodeURIComponent(input.workItemId) +
        "/tasks?includeArchived=" +
        (inc ? "true" : "false"),
      { auth: "read" },
    );
    const items = res.data.items;
    if (input.status) return items.filter((t) => String(t.status) === String(input.status));
    return items;
  }

  async getProject(projectId: string): Promise<SkProject> {
    const res = await this.requestJson<{ data: SkProject }>(
      "/projects/" + encodeURIComponent(projectId),
      { auth: "read" },
    );
    return res.data;
  }

  async getWorkItem(workItemId: string): Promise<SkWorkItem> {
    const res = await this.requestJson<{ data: SkWorkItem }>(
      "/work-items/" + encodeURIComponent(workItemId),
      { auth: "read" },
    );
    return res.data;
  }

  async getTask(taskId: string): Promise<SkTask> {
    const res = await this.requestJson<{ data: SkTask }>("/tasks/" + encodeURIComponent(taskId), {
      auth: "read",
    });
    return res.data;
  }

  // WRITE integration endpoints
  async upsertProject(input: {
    externalId: string;
    name: string;
    mode?: "OPENCLAW_MODE" | "AUTOMAKER_MODE";
    projectRootPath?: string | null;
    manualVerificationEnabled?: boolean;
    pipelineSteps?: Array<{ key: string; label: string; order: number }>;
  }): Promise<{ created: boolean; item: SkProject }> {
    const res = await this.requestJson<{ data: { created: boolean; item: SkProject } }>(
      "/integrations/openclaw/projects/upsert",
      {
        method: "POST",
        auth: "write",
        body: {
          externalId: input.externalId,
          name: input.name,
          mode: input.mode ?? "OPENCLAW_MODE",
          projectRootPath: input.projectRootPath ?? undefined,
          manualVerificationEnabled: input.manualVerificationEnabled ?? undefined,
          pipelineSteps: input.pipelineSteps ?? undefined,
        },
      },
    );
    return res.data;
  }

  async upsertWorkItem(input: {
    externalId: string;
    projectId?: string;
    projectExternalId?: string;
    title: string;
    description?: string | null;
    status: string;
    pipelineStepKey?: string | null;
    position?: number;
    archivedAt?: string | null;
  }): Promise<{ created: boolean; item: SkWorkItem }> {
    if (!input.projectId && !input.projectExternalId) {
      throw new Error("upsertWorkItem requires projectId or projectExternalId");
    }
    if (input.projectId && input.projectExternalId) {
      throw new Error("upsertWorkItem: provide only one of projectId or projectExternalId");
    }

    const res = await this.requestJson<{ data: { created: boolean; item: SkWorkItem } }>(
      "/integrations/openclaw/work-items/upsert",
      {
        method: "POST",
        auth: "write",
        body: {
          externalId: input.externalId,
          projectId: input.projectId,
          projectExternalId: input.projectExternalId,
          title: input.title,
          description: input.description ?? undefined,
          status: input.status,
          pipelineStepKey: input.pipelineStepKey ?? undefined,
          position: input.position ?? undefined,
          archivedAt: input.archivedAt ?? undefined,
        },
      },
    );
    return res.data;
  }

  async upsertTask(input: {
    externalId: string;
    projectId?: string;
    projectExternalId?: string;
    workItemId?: string | null;
    workItemExternalId?: string;
    title: string;
    description?: string | null;
    status: string;
    position?: number;
    archivedAt?: string | null;
  }): Promise<{ created: boolean; item: SkTask }> {
    if (!input.projectId && !input.projectExternalId) {
      throw new Error("upsertTask requires projectId or projectExternalId");
    }
    if (input.projectId && input.projectExternalId) {
      throw new Error("upsertTask: provide only one of projectId or projectExternalId");
    }
    if (input.workItemId !== undefined && input.workItemExternalId !== undefined) {
      throw new Error("upsertTask: do not provide both workItemId and workItemExternalId");
    }

    const res = await this.requestJson<{ data: { created: boolean; item: SkTask } }>(
      "/integrations/openclaw/tasks/upsert",
      {
        method: "POST",
        auth: "write",
        body: {
          externalId: input.externalId,
          projectId: input.projectId,
          projectExternalId: input.projectExternalId,
          workItemId: input.workItemId,
          workItemExternalId: input.workItemExternalId,
          title: input.title,
          description: input.description ?? undefined,
          status: input.status,
          position: input.position ?? undefined,
          archivedAt: input.archivedAt ?? undefined,
        },
      },
    );
    return res.data;
  }

  async attachSession(input: {
    entityType: "PROJECT" | "WORK_ITEM" | "TASK";
    entityId: string;
    sessionKey: string;
    state: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
    runId?: string | null;
    jobId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
  }): Promise<void> {
    await this.requestJson("/sessions/attach", {
      method: "POST",
      auth: "write",
      body: {
        entityType: input.entityType,
        entityId: input.entityId,
        sessionKey: input.sessionKey,
        state: input.state,
        runId: input.runId ?? undefined,
        jobId: input.jobId ?? undefined,
        startedAt: input.startedAt ?? undefined,
        endedAt: input.endedAt ?? undefined,
      },
    });
  }

  async createEvent(input: {
    eventId: string;
    payload: unknown;
    entityVersion?: number | null;
  }): Promise<{ item: any; deduped: boolean }> {
    const res = await this.requestJson<{ data: { item: any; deduped: boolean } }>("/events", {
      method: "POST",
      auth: "write",
      body: {
        eventId: input.eventId,
        entityVersion: input.entityVersion ?? null,
        payload: input.payload,
      },
    });
    return res.data;
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
      }>("/sessions/resolve?sessionKey=" + encodeURIComponent(sessionKey), { auth: "read" });
      return res.data;
    } catch (err) {
      const status = (err as any)?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async listProjectSessions(projectId: string): Promise<SkSessionSummary[]> {
    const res = await this.requestJson<{ data: { items: SkSessionSummary[] } }>(
      "/projects/" + encodeURIComponent(projectId) + "/sessions?limit=50",
      { auth: "read" },
    );
    return res.data.items;
  }

  async listWorkItemSessions(workItemId: string): Promise<SkSessionSummary[]> {
    const res = await this.requestJson<{ data: { items: SkSessionSummary[] } }>(
      "/work-items/" + encodeURIComponent(workItemId) + "/sessions?limit=50",
      { auth: "read" },
    );
    return res.data.items;
  }

  async listTaskSessions(taskId: string): Promise<SkSessionSummary[]> {
    const res = await this.requestJson<{ data: { items: SkSessionSummary[] } }>(
      "/tasks/" + encodeURIComponent(taskId) + "/sessions?limit=50",
      { auth: "read" },
    );
    return res.data.items;
  }

  async lockTask(input: { taskId: string; owner: string; ttlSeconds: number }): Promise<void> {
    await this.requestJson("/tasks/" + encodeURIComponent(input.taskId) + "/lock", {
      method: "POST",
      auth: "write",
      body: { owner: input.owner, ttlSeconds: input.ttlSeconds },
    });
  }

  async unlockTask(input: { taskId: string; owner: string }): Promise<void> {
    await this.requestJson("/tasks/" + encodeURIComponent(input.taskId) + "/unlock", {
      method: "POST",
      auth: "write",
      body: { owner: input.owner },
    });
  }

  async patchTaskStatus(input: { taskId: string; status: string }): Promise<void> {
    await this.requestJson("/tasks/" + encodeURIComponent(input.taskId), {
      method: "PATCH",
      auth: "write",
      body: { status: input.status },
    });
  }

  async patchWorkItemStatus(input: { workItemId: string; status: string }): Promise<void> {
    await this.requestJson("/work-items/" + encodeURIComponent(input.workItemId), {
      method: "PATCH",
      auth: "write",
      body: { status: input.status },
    });
  }

  async patchProjectArchived(input: { projectId: string; archived: boolean }): Promise<void> {
    await this.requestJson("/projects/" + encodeURIComponent(input.projectId), {
      method: "PATCH",
      auth: "write",
      body: { archived: input.archived },
    });
  }

  async patchWorkItemArchived(input: { workItemId: string; archived: boolean }): Promise<void> {
    await this.requestJson("/work-items/" + encodeURIComponent(input.workItemId), {
      method: "PATCH",
      auth: "write",
      body: { archived: input.archived },
    });
  }

  async patchTaskArchived(input: { taskId: string; archived: boolean }): Promise<void> {
    await this.requestJson("/tasks/" + encodeURIComponent(input.taskId), {
      method: "PATCH",
      auth: "write",
      body: { archived: input.archived },
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
        "If true, wake the parent session when the spawned subagent run ends via gateway agent RPC (best-effort). Default: true (opt-out with false).",
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

// --- ExternalId canonicalization (SK-Sync protocol) ---

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v ? v : undefined;
}

function assertValidKey(label: string, value: string): void {
  if (!value) throw new Error(`${label} must be non-empty`);
  if (value.includes(":")) {
    throw new Error(`${label} must not contain ':' (got ${JSON.stringify(value)})`);
  }
}

export function canonicalizeProjectExternalId(input: string): {
  externalId: string;
  projectKey: string;
} {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("projectExternalId must be a non-empty string");

  if (raw.startsWith("project:")) {
    const projectKey = raw.slice("project:".length);
    assertValidKey("projectKey", projectKey);
    return { externalId: `project:${projectKey}`, projectKey };
  }

  if (!raw.includes(":")) {
    const projectKey = raw;
    assertValidKey("projectKey", projectKey);
    return { externalId: `project:${projectKey}`, projectKey };
  }

  throw new Error(
    `Invalid projectExternalId ${JSON.stringify(input)}. Expected 'project:<projectKey>' or '<projectKey>'.`,
  );
}

export function canonicalizeWorkItemExternalId(
  input: string,
  projectKey: string,
): { externalId: string; workItemKey: string } {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("workItemExternalId must be a non-empty string");

  if (raw.startsWith("workitem:")) {
    const m = /^workitem:([^:]+):([^:]+)$/.exec(raw);
    if (!m) {
      throw new Error(
        `Invalid workItemExternalId ${JSON.stringify(input)}. Expected 'workitem:<projectKey>:<workItemKey>'.`,
      );
    }
    const [, pKey, wKey] = m;
    if (pKey !== projectKey) {
      throw new Error(
        `workItemExternalId projectKey mismatch (expected ${JSON.stringify(projectKey)}, got ${JSON.stringify(pKey)})`,
      );
    }
    assertValidKey("workItemKey", wKey);
    return { externalId: `workitem:${pKey}:${wKey}`, workItemKey: wKey };
  }

  if (!raw.includes(":")) {
    const workItemKey = raw;
    assertValidKey("workItemKey", workItemKey);
    return { externalId: `workitem:${projectKey}:${workItemKey}`, workItemKey };
  }

  throw new Error(
    `Invalid workItemExternalId ${JSON.stringify(input)}. Expected 'workitem:<projectKey>:<workItemKey>' or '<workItemKey>'.`,
  );
}

export function canonicalizeTaskExternalId(
  input: string,
  projectKey: string,
  workItemKey: string,
): { externalId: string; taskKey: string } {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("taskExternalId must be a non-empty string");

  if (raw.startsWith("task:")) {
    const m = /^task:([^:]+):([^:]+):([^:]+)$/.exec(raw);
    if (!m) {
      throw new Error(
        `Invalid taskExternalId ${JSON.stringify(input)}. Expected 'task:<projectKey>:<workItemKey>:<taskKey>'.`,
      );
    }
    const [, pKey, wKey, tKey] = m;
    if (pKey !== projectKey) {
      throw new Error(
        `taskExternalId projectKey mismatch (expected ${JSON.stringify(projectKey)}, got ${JSON.stringify(pKey)})`,
      );
    }
    if (wKey !== workItemKey) {
      throw new Error(
        `taskExternalId workItemKey mismatch (expected ${JSON.stringify(workItemKey)}, got ${JSON.stringify(wKey)})`,
      );
    }
    assertValidKey("taskKey", tKey);
    return { externalId: `task:${pKey}:${wKey}:${tKey}`, taskKey: tKey };
  }

  if (!raw.includes(":")) {
    const taskKey = raw;
    assertValidKey("taskKey", taskKey);
    return { externalId: `task:${projectKey}:${workItemKey}:${taskKey}`, taskKey };
  }

  throw new Error(
    `Invalid taskExternalId ${JSON.stringify(input)}. Expected 'task:<projectKey>:<workItemKey>:<taskKey>' or '<taskKey>'.`,
  );
}

type SkSyncCanonicalized = {
  projectExternalId: string;
  projectName: string;
  projectKey: string;

  workItemExternalId?: string;
  workItemTitle?: string;
  workItemKey?: string;

  taskExternalId?: string;
  taskTitle?: string;
  taskKey?: string;
};

export function resolveSkSyncCanonicalization(input: {
  projectExternalId: string;
  projectName?: string;
  workItemExternalId?: string;
  workItemTitle?: string;
  taskExternalId?: string;
  taskTitle?: string;
}): SkSyncCanonicalized {
  const project = canonicalizeProjectExternalId(input.projectExternalId);
  const projectName = trimmedOrUndefined(input.projectName) ?? project.projectKey;

  let workItemKey: string | undefined;
  let workItemExternalId: string | undefined;
  let workItemTitle: string | undefined;

  if (input.workItemExternalId !== undefined) {
    const workItem = canonicalizeWorkItemExternalId(input.workItemExternalId, project.projectKey);
    workItemKey = workItem.workItemKey;
    workItemExternalId = workItem.externalId;
    workItemTitle = trimmedOrUndefined(input.workItemTitle) ?? workItemKey;
  }

  let taskKey: string | undefined;
  let taskExternalId: string | undefined;
  let taskTitle: string | undefined;

  if (input.taskExternalId !== undefined) {
    if (!workItemKey) {
      throw new Error("taskExternalId requires workItemExternalId to resolve workItemKey");
    }
    const task = canonicalizeTaskExternalId(input.taskExternalId, project.projectKey, workItemKey);
    taskKey = task.taskKey;
    taskExternalId = task.externalId;
    taskTitle = trimmedOrUndefined(input.taskTitle) ?? taskKey;
  }

  return {
    projectExternalId: project.externalId,
    projectName,
    projectKey: project.projectKey,
    workItemExternalId,
    workItemTitle,
    workItemKey,
    taskExternalId,
    taskTitle,
    taskKey,
  };
}

export function resolveWakeParentOnEnd(value?: boolean): boolean {
  // Default is true; opt-out via explicit false.
  return value !== false;
}

type WakeParentOnEndEntry = {
  parentSessionKey: string;
  childSessionKey: string;
  wakeParentOnEnd: boolean;
};

export function createWakeParentOnEndTracker(params: {
  logger: { warn: (msg: string) => void };
  wakeParent?: (input: {
    sessionKey: string;
    message: string;
    deliver: true;
    channel: "last";
    idempotencyKey: string;
    lane?: string;
  }) => Promise<unknown>;
}): {
  trackSpawn: (input: {
    runId: string | null;
    parentSessionKey: string | null;
    childSessionKey: string;
    wakeParentOnEnd?: boolean;
  }) => void;
  handleSubagentEnded: (input: { runId?: string | null; outcome?: string }) => Promise<void>;
} {
  const entriesByRunId = new Map<string, WakeParentOnEndEntry>();

  const wakeParent =
    params.wakeParent ??
    (async (input: {
      sessionKey: string;
      message: string;
      deliver: true;
      channel: "last";
      idempotencyKey: string;
      lane?: string;
    }) => {
      return await callGateway({
        method: "agent",
        params: {
          sessionKey: input.sessionKey,
          message: input.message,
          deliver: input.deliver,
          channel: input.channel,
          idempotencyKey: input.idempotencyKey,
          lane: input.lane,
        },
      });
    });

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

    const status = mapOutcomeToSessionState(input.outcome);
    const outcome = input.outcome ?? "unknown";

    try {
      await wakeParent({
        sessionKey: entry.parentSessionKey,
        deliver: true,
        channel: "last",
        lane: "sk-sync-wake",
        idempotencyKey: randomIdempotencyKey(),
        message:
          "SK-Sync wake: subagent ended status=" +
          status +
          " child=" +
          entry.childSessionKey +
          " run=" +
          runId +
          " outcome=" +
          outcome +
          ". Respond with a brief ack + next step.",
      });
    } catch (err) {
      params.logger.warn("[sk-sync] wakeParentOnEnd: agent rpc failed: " + String(err));
    }
  }

  return { trackSpawn, handleSubagentEnded };
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

      bearerToken: { type: "string" },
      apiKey: { type: "string" },

      token: { type: "string" },
      authHeader: { type: "string" },
      authHeaderRead: { type: "string" },
      authHeaderWrite: { type: "string" },

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
          throw new Error("SK-Sync requires baseUrl (SUPERKANBAN_BASE_URL or plugin config)");
        }

        const args = raw as SkSyncSpawnArgs;

        // Validate required fields before canonicalization for clearer errors.
        if ((args.level === "ATLAS" || args.level === "WORKER") && !args.workItemExternalId) {
          throw new Error("workItemExternalId is required for level=ATLAS|WORKER");
        }
        if (args.level === "WORKER" && !args.taskExternalId) {
          throw new Error("taskExternalId is required for level=WORKER");
        }

        // Canonicalize externalIds + resolve default names/titles to prevent non-protocol IDs (e.g. "undefined").
        const canon = resolveSkSyncCanonicalization({
          projectExternalId: args.projectExternalId,
          projectName: args.projectName,
          workItemExternalId: args.workItemExternalId,
          workItemTitle: args.workItemTitle,
          taskExternalId: args.taskExternalId,
          taskTitle: args.taskTitle,
        });
        args.projectExternalId = canon.projectExternalId;
        args.projectName = canon.projectName;
        if (args.workItemExternalId !== undefined) {
          args.workItemExternalId = canon.workItemExternalId;
          args.workItemTitle = canon.workItemTitle;
        }
        if (args.taskExternalId !== undefined) {
          args.taskExternalId = canon.taskExternalId;
          args.taskTitle = canon.taskTitle;
        }

        const nowIso = new Date().toISOString();

        // Ensure entities
        const projectUpsert = await params.sk.upsertProject({
          externalId: args.projectExternalId,
          name: args.projectName ?? args.projectExternalId,
          projectRootPath: args.projectRootPath ?? null,
        });
        const project = projectUpsert.item;

        let workItem: SkWorkItem | null = null;
        let taskEntity: SkTask | null = null;

        if (args.level === "ATLAS" || args.level === "WORKER") {
          if (!args.workItemExternalId) {
            throw new Error("workItemExternalId is required for level=ATLAS|WORKER");
          }
          workItem = (
            await params.sk.upsertWorkItem({
              externalId: args.workItemExternalId,
              projectId: project.id,
              title: args.workItemTitle ?? args.workItemExternalId,
              description: args.workItemDescription ?? null,
              status: "IN_PROGRESS",
            })
          ).item;
        }

        if (args.level === "WORKER") {
          if (!args.taskExternalId) {
            throw new Error("taskExternalId is required for level=WORKER");
          }
          if (!workItem) {
            throw new Error("internal error: workItem must be resolved for level=WORKER");
          }
          taskEntity = (
            await params.sk.upsertTask({
              externalId: args.taskExternalId,
              projectId: project.id,
              workItemId: workItem.id,
              title: args.taskTitle ?? args.taskExternalId,
              description: args.taskDescription ?? null,
              status: "IN_PROGRESS",
            })
          ).item;
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

// --- SK-Sync direct Super-Kanban tools (no skills) ---

const OPENCLAW_EXTERNAL_SYSTEM = "openclaw";
const SK_ENTITY_TYPES = ["PROJECT", "WORK_ITEM", "TASK"] as const;
const SK_WORK_ITEM_STATUSES = [
  "BACKLOG",
  "IN_PROGRESS",
  "WAITING_APPROVAL",
  "VERIFIED",
  "BLOCKED",
  "CANCELLED",
] as const;
const SK_TASK_STATUSES = [
  "BACKLOG",
  "IN_PROGRESS",
  "BLOCKED",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
] as const;

function sha256Hex(s: string): string {
  return createHash("sha256")
    .update(String(s ?? ""), "utf8")
    .digest("hex");
}

function toolJson(tool: string, data: any) {
  const payload = { ok: true, tool, data };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function findUniqueByExternalRef<
  T extends { externalSystem: string | null; externalId: string | null },
>(items: T[], externalId: string): T | null {
  const matches = (items || []).filter(
    (x) =>
      String(x?.externalSystem || "").toLowerCase() === OPENCLAW_EXTERNAL_SYSTEM &&
      x?.externalId === externalId,
  );
  if (matches.length > 1) {
    throw new Error(
      "Non-unique external reference for externalSystem=openclaw externalId=" +
        externalId +
        " (matches=" +
        matches.length +
        ")",
    );
  }
  return matches[0] || null;
}

function parseProjectExternalId(externalId: string): { projectKey: string } {
  const raw = String(externalId || "").trim();
  const m = /^project:([^:]+)$/.exec(raw);
  if (!m) {
    throw new Error(
      "Invalid projectExternalId: " +
        JSON.stringify(externalId) +
        " (expected: project:<projectKey>)",
    );
  }
  return { projectKey: m[1] };
}

function parseWorkItemExternalId(externalId: string): { projectKey: string; workItemKey: string } {
  const raw = String(externalId || "").trim();
  const m = /^workitem:([^:]+):([^:]+)$/.exec(raw);
  if (!m) {
    throw new Error(
      "Invalid workItemExternalId: " +
        JSON.stringify(externalId) +
        " (expected: workitem:<projectKey>:<workItemKey>)",
    );
  }
  return { projectKey: m[1], workItemKey: m[2] };
}

async function resolveProjectIdByExternalId(
  sk: SkClient,
  projectExternalId: string,
): Promise<string | null> {
  const projects = await sk.listProjects({ includeArchived: true });
  const proj = findUniqueByExternalRef(projects, projectExternalId);
  return proj?.id ?? null;
}

async function resolveWorkItemIdByExternalId(
  sk: SkClient,
  workItemExternalId: string,
): Promise<{ projectId: string; workItemId: string } | null> {
  const { projectKey } = parseWorkItemExternalId(workItemExternalId);
  const projectExternalId = "project:" + projectKey;
  const projectId = await resolveProjectIdByExternalId(sk, projectExternalId);
  if (!projectId) return null;

  const workItems = await sk.listWorkItemsByProjectId({ projectId, includeArchived: true });
  const wi = findUniqueByExternalRef(workItems, workItemExternalId);
  if (!wi?.id) return null;

  return { projectId, workItemId: wi.id };
}

const SkListProjectsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    includeArchived: { type: "boolean", default: false },
  },
};

const SkListWorkItemsSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["projectId"],
      properties: {
        projectId: { type: "string", minLength: 1 },
        includeArchived: { type: "boolean", default: false },
        status: { type: "string", enum: SK_WORK_ITEM_STATUSES as unknown as string[] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["projectExternalId"],
      properties: {
        projectExternalId: { type: "string", minLength: 1 },
        includeArchived: { type: "boolean", default: false },
        status: { type: "string", enum: SK_WORK_ITEM_STATUSES as unknown as string[] },
      },
    },
  ],
} as const;

const SkListTasksSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["workItemId"],
      properties: {
        workItemId: { type: "string", minLength: 1 },
        includeArchived: { type: "boolean", default: false },
        status: { type: "string", enum: SK_TASK_STATUSES as unknown as string[] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["workItemExternalId"],
      properties: {
        workItemExternalId: { type: "string", minLength: 1 },
        includeArchived: { type: "boolean", default: false },
        status: { type: "string", enum: SK_TASK_STATUSES as unknown as string[] },
      },
    },
  ],
} as const;

const SkGetEntityBySessionKeySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionKey"],
  properties: {
    sessionKey: { type: "string", minLength: 1 },
  },
};

const SkListSessionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entityType", "entityId"],
  properties: {
    entityType: { type: "string", enum: SK_ENTITY_TYPES as unknown as string[] },
    entityId: { type: "string", minLength: 1 },
  },
};

const SkUpsertProjectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["externalId", "name"],
  properties: {
    externalId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["OPENCLAW_MODE", "AUTOMAKER_MODE"] },
    projectRootPath: { type: ["string", "null"] },
    manualVerificationEnabled: { type: "boolean" },
    pipelineSteps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "order"],
        properties: {
          key: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          order: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const;

const SkUpsertWorkItemSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["externalId", "projectId", "title", "status"],
      properties: {
        externalId: { type: "string", minLength: 1 },
        projectId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: ["string", "null"] },
        status: { type: "string", enum: SK_WORK_ITEM_STATUSES as unknown as string[] },
        pipelineStepKey: { type: ["string", "null"] },
        position: { type: "integer", minimum: 0 },
        archivedAt: { type: ["string", "null"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["externalId", "projectExternalId", "title", "status"],
      properties: {
        externalId: { type: "string", minLength: 1 },
        projectExternalId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: ["string", "null"] },
        status: { type: "string", enum: SK_WORK_ITEM_STATUSES as unknown as string[] },
        pipelineStepKey: { type: ["string", "null"] },
        position: { type: "integer", minimum: 0 },
        archivedAt: { type: ["string", "null"] },
      },
    },
  ],
} as const;

const SkUpsertTaskSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["externalId", "projectId", "workItemId", "title", "status"],
      properties: {
        externalId: { type: "string", minLength: 1 },
        projectId: { type: "string", minLength: 1 },
        workItemId: { type: ["string", "null"] },
        title: { type: "string", minLength: 1 },
        description: { type: ["string", "null"] },
        status: { type: "string", enum: SK_TASK_STATUSES as unknown as string[] },
        position: { type: "integer", minimum: 0 },
        archivedAt: { type: ["string", "null"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["externalId", "projectId", "workItemExternalId", "title", "status"],
      properties: {
        externalId: { type: "string", minLength: 1 },
        projectId: { type: "string", minLength: 1 },
        workItemExternalId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: ["string", "null"] },
        status: { type: "string", enum: SK_TASK_STATUSES as unknown as string[] },
        position: { type: "integer", minimum: 0 },
        archivedAt: { type: ["string", "null"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["externalId", "projectExternalId", "workItemId", "title", "status"],
      properties: {
        externalId: { type: "string", minLength: 1 },
        projectExternalId: { type: "string", minLength: 1 },
        workItemId: { type: ["string", "null"] },
        title: { type: "string", minLength: 1 },
        description: { type: ["string", "null"] },
        status: { type: "string", enum: SK_TASK_STATUSES as unknown as string[] },
        position: { type: "integer", minimum: 0 },
        archivedAt: { type: ["string", "null"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["externalId", "projectExternalId", "workItemExternalId", "title", "status"],
      properties: {
        externalId: { type: "string", minLength: 1 },
        projectExternalId: { type: "string", minLength: 1 },
        workItemExternalId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: ["string", "null"] },
        status: { type: "string", enum: SK_TASK_STATUSES as unknown as string[] },
        position: { type: "integer", minimum: 0 },
        archivedAt: { type: ["string", "null"] },
      },
    },
  ],
} as const;

const SkGetStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entityType", "entityId"],
  properties: {
    entityType: { type: "string", enum: SK_ENTITY_TYPES as unknown as string[] },
    entityId: { type: "string", minLength: 1 },
  },
} as const;

const SkSetStatusSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["entityType", "entityId", "status"],
      properties: {
        entityType: { const: "TASK" },
        entityId: { type: "string", minLength: 1 },
        status: { type: "string", enum: SK_TASK_STATUSES as unknown as string[] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["entityType", "entityId", "status"],
      properties: {
        entityType: { const: "WORK_ITEM" },
        entityId: { type: "string", minLength: 1 },
        status: { type: "string", enum: SK_WORK_ITEM_STATUSES as unknown as string[] },
      },
    },
  ],
} as const;

const SkSetArchivedSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["entityType", "entityId", "archived"],
      properties: {
        entityType: { const: "PROJECT" },
        entityId: { type: "string", minLength: 1 },
        archived: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["entityType", "entityId", "archived"],
      properties: {
        entityType: { const: "WORK_ITEM" },
        entityId: { type: "string", minLength: 1 },
        archived: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["entityType", "entityId", "archived"],
      properties: {
        entityType: { const: "TASK" },
        entityId: { type: "string", minLength: 1 },
        archived: { type: "boolean" },
      },
    },
  ],
} as const;

const SkAddCommentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entityType", "entityId", "message"],
  properties: {
    entityType: { type: "string", enum: SK_ENTITY_TYPES as unknown as string[] },
    entityId: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
    eventId: { type: "string", minLength: 1 },
    sessionKey: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
  },
} as const;

function createSkListProjectsTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_list_projects",
      label: "SK: list projects",
      description: "List Super-Kanban projects (READ_UI).",
      parameters: SkListProjectsSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as { includeArchived?: boolean };
        const items = await params.sk.listProjects({
          includeArchived: args.includeArchived ?? false,
        });
        return toolJson("sk_list_projects", { items });
      },
    }) satisfies AnyAgentTool;
}

function createSkListWorkItemsTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_list_work_items",
      label: "SK: list work items",
      description: "List work items for a project (READ_UI).",
      parameters: SkListWorkItemsSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as any;
        const includeArchived = args.includeArchived ?? false;
        const status = args.status;

        let projectId = args.projectId ? String(args.projectId) : "";
        let projectExternalId = args.projectExternalId ? String(args.projectExternalId) : "";

        if (!projectId) {
          if (!projectExternalId) throw new Error("projectId or projectExternalId is required");
          parseProjectExternalId(projectExternalId);
          const resolved = await resolveProjectIdByExternalId(params.sk, projectExternalId);
          if (!resolved) {
            return toolJson("sk_list_work_items", {
              found: false,
              projectId: null,
              projectExternalId,
              items: [],
            });
          }
          projectId = resolved;
        }

        const items = await params.sk.listWorkItemsByProjectId({
          projectId,
          includeArchived,
          status,
        });
        return toolJson("sk_list_work_items", {
          found: true,
          projectId,
          projectExternalId: projectExternalId || null,
          items,
        });
      },
    }) satisfies AnyAgentTool;
}

function createSkListTasksTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_list_tasks",
      label: "SK: list tasks",
      description: "List tasks for a work item (READ_UI).",
      parameters: SkListTasksSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as any;
        const includeArchived = args.includeArchived ?? false;

        let workItemId = args.workItemId ? String(args.workItemId) : "";
        const workItemExternalId = args.workItemExternalId ? String(args.workItemExternalId) : "";

        if (!workItemId) {
          if (!workItemExternalId) throw new Error("workItemId or workItemExternalId is required");
          const resolved = await resolveWorkItemIdByExternalId(params.sk, workItemExternalId);
          if (!resolved) {
            return toolJson("sk_list_tasks", {
              found: false,
              workItemId: null,
              workItemExternalId,
              items: [],
            });
          }
          workItemId = resolved.workItemId;
        }

        const items = await params.sk.listTasksByWorkItemId({
          workItemId,
          includeArchived,
          status,
        });
        return toolJson("sk_list_tasks", {
          found: true,
          workItemId,
          workItemExternalId: workItemExternalId || null,
          items,
        });
      },
    }) satisfies AnyAgentTool;
}

function createSkGetEntityBySessionKeyTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_get_entity_by_session_key",
      label: "SK: resolve sessionKey",
      description: "Resolve a Super-Kanban execution session by sessionKey (READ_UI).",
      parameters: SkGetEntityBySessionKeySchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as { sessionKey: string };
        const sessionKey = String(args.sessionKey || "").trim();
        if (!sessionKey) throw new Error("sessionKey is required");
        const resolved = await params.sk.resolveSessionBySessionKey(sessionKey);
        return toolJson("sk_get_entity_by_session_key", {
          found: Boolean(resolved),
          sessionKey,
          resolved,
        });
      },
    }) satisfies AnyAgentTool;
}

function createSkListSessionsTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_list_sessions",
      label: "SK: list sessions",
      description: "List execution sessions attached to an entity (READ_UI).",
      parameters: SkListSessionsSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as { entityType: string; entityId: string };
        const entityType = String(args.entityType || "")
          .trim()
          .toUpperCase();
        const entityId = String(args.entityId || "").trim();
        if (!entityType || !entityId) throw new Error("entityType and entityId are required");

        let items: SkSessionSummary[] = [];
        if (entityType === "PROJECT") items = await params.sk.listProjectSessions(entityId);
        else if (entityType === "WORK_ITEM") items = await params.sk.listWorkItemSessions(entityId);
        else if (entityType === "TASK") items = await params.sk.listTaskSessions(entityId);
        else throw new Error("Invalid entityType: " + entityType);

        return toolJson("sk_list_sessions", { entityType, entityId, items });
      },
    }) satisfies AnyAgentTool;
}

function createSkGetActiveSessionTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_get_active_session",
      label: "SK: get active session",
      description: "Return the RUNNING execution session for an entity if present (READ_UI).",
      parameters: SkListSessionsSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as { entityType: string; entityId: string };
        const entityType = String(args.entityType || "")
          .trim()
          .toUpperCase();
        const entityId = String(args.entityId || "").trim();

        let items: SkSessionSummary[] = [];
        if (entityType === "PROJECT") items = await params.sk.listProjectSessions(entityId);
        else if (entityType === "WORK_ITEM") items = await params.sk.listWorkItemSessions(entityId);
        else if (entityType === "TASK") items = await params.sk.listTaskSessions(entityId);
        else throw new Error("Invalid entityType: " + entityType);

        const active = items.find((s) => s.state === "RUNNING") || items[0] || null;
        return toolJson("sk_get_active_session", {
          entityType,
          entityId,
          found: Boolean(active),
          session: active,
        });
      },
    }) satisfies AnyAgentTool;
}

function createSkUpsertProjectTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_upsert_project",
      label: "SK: upsert project",
      description: "Upsert a project (WRITE_INTEGRATION).",
      parameters: SkUpsertProjectSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as any;
        const externalId = String(args.externalId || "").trim();
        const name = String(args.name || "").trim();
        if (!externalId || !name) throw new Error("externalId and name are required");

        const res = await params.sk.upsertProject({
          externalId,
          name,
          mode: args.mode,
          projectRootPath: args.projectRootPath,
          manualVerificationEnabled: args.manualVerificationEnabled,
          pipelineSteps: args.pipelineSteps,
        });
        return toolJson("sk_upsert_project", res);
      },
    }) satisfies AnyAgentTool;
}

function createSkUpsertWorkItemTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_upsert_work_item",
      label: "SK: upsert work item",
      description: "Upsert a work item (WRITE_INTEGRATION).",
      parameters: SkUpsertWorkItemSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as any;
        const res = await params.sk.upsertWorkItem({
          externalId: args.externalId,
          projectId: args.projectId,
          projectExternalId: args.projectExternalId,
          title: args.title,
          description: args.description,
          status: args.status,
          pipelineStepKey: args.pipelineStepKey,
          position: args.position,
          archivedAt: args.archivedAt,
        });
        return toolJson("sk_upsert_work_item", res);
      },
    }) satisfies AnyAgentTool;
}

function createSkUpsertTaskTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_upsert_task",
      label: "SK: upsert task",
      description: "Upsert a task (WRITE_INTEGRATION).",
      parameters: SkUpsertTaskSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as any;
        const res = await params.sk.upsertTask({
          externalId: args.externalId,
          projectId: args.projectId,
          projectExternalId: args.projectExternalId,
          workItemId: args.workItemId,
          workItemExternalId: args.workItemExternalId,
          title: args.title,
          description: args.description,
          status: args.status,
          position: args.position,
          archivedAt: args.archivedAt,
        });
        return toolJson("sk_upsert_task", res);
      },
    }) satisfies AnyAgentTool;
}

function createSkGetStatusTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_get_status",
      label: "SK: get status",
      description: "Get entity status (READ_UI).",
      parameters: SkGetStatusSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as { entityType: string; entityId: string };
        const entityType = String(args.entityType || "")
          .trim()
          .toUpperCase();
        const entityId = String(args.entityId || "").trim();
        if (!entityType || !entityId) throw new Error("entityType and entityId are required");

        if (entityType === "TASK") {
          const task = await params.sk.getTask(entityId);
          return toolJson("sk_get_status", {
            entityType,
            entityId,
            status: task.status,
            archived: task.isArchived,
            item: task,
          });
        }
        if (entityType === "WORK_ITEM") {
          const wi = await params.sk.getWorkItem(entityId);
          return toolJson("sk_get_status", {
            entityType,
            entityId,
            status: wi.status,
            archived: wi.isArchived,
            item: wi,
          });
        }
        if (entityType === "PROJECT") {
          const p = await params.sk.getProject(entityId);
          return toolJson("sk_get_status", {
            entityType,
            entityId,
            status: p.isArchived ? "ARCHIVED" : "ACTIVE",
            archived: p.isArchived,
            item: p,
          });
        }
        throw new Error("Invalid entityType: " + entityType);
      },
    }) satisfies AnyAgentTool;
}

function createSkSetStatusTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_set_status",
      label: "SK: set status",
      description: "Set status for TASK/WORK_ITEM (WRITE_INTEGRATION).",
      parameters: SkSetStatusSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as any;
        const entityType = String(args.entityType || "")
          .trim()
          .toUpperCase();
        const entityId = String(args.entityId || "").trim();
        const status = String(args.status || "").trim();
        if (!entityType || !entityId || !status)
          throw new Error("entityType, entityId, status are required");

        if (entityType === "TASK") {
          await params.sk.patchTaskStatus({ taskId: entityId, status });
          const item = await params.sk.getTask(entityId);
          return toolJson("sk_set_status", { entityType, entityId, status: item.status, item });
        }
        if (entityType === "WORK_ITEM") {
          await params.sk.patchWorkItemStatus({ workItemId: entityId, status });
          const item = await params.sk.getWorkItem(entityId);
          return toolJson("sk_set_status", { entityType, entityId, status: item.status, item });
        }
        throw new Error("sk_set_status only supports entityType=TASK|WORK_ITEM");
      },
    }) satisfies AnyAgentTool;
}

function createSkSetArchivedTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_set_archived",
      label: "SK: set archived",
      description: "Archive/unarchive entity (WRITE_INTEGRATION).",
      parameters: SkSetArchivedSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as any;
        const entityType = String(args.entityType || "")
          .trim()
          .toUpperCase();
        const entityId = String(args.entityId || "").trim();
        const archived = Boolean(args.archived);
        if (!entityType || !entityId) throw new Error("entityType and entityId are required");

        if (entityType === "PROJECT") {
          await params.sk.patchProjectArchived({ projectId: entityId, archived });
          const item = await params.sk.getProject(entityId);
          return toolJson("sk_set_archived", {
            entityType,
            entityId,
            archived: item.isArchived,
            item,
          });
        }
        if (entityType === "WORK_ITEM") {
          await params.sk.patchWorkItemArchived({ workItemId: entityId, archived });
          const item = await params.sk.getWorkItem(entityId);
          return toolJson("sk_set_archived", {
            entityType,
            entityId,
            archived: item.isArchived,
            item,
          });
        }
        if (entityType === "TASK") {
          await params.sk.patchTaskArchived({ taskId: entityId, archived });
          const item = await params.sk.getTask(entityId);
          return toolJson("sk_set_archived", {
            entityType,
            entityId,
            archived: item.isArchived,
            item,
          });
        }
        throw new Error("Invalid entityType: " + entityType);
      },
    }) satisfies AnyAgentTool;
}

function createSkAddCommentTool(params: { config: SkSyncConfig; sk: SkClient }) {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "sk_add_comment",
      label: "SK: add comment",
      description: "Add a comment via domain event (WRITE_INTEGRATION).",
      parameters: SkAddCommentSchema,
      execute: async (_toolCallId, raw) => {
        const args = (raw || {}) as any;
        const entityType = String(args.entityType || "")
          .trim()
          .toUpperCase();
        const entityId = String(args.entityId || "").trim();
        const message = String(args.message || "").trim();
        if (!entityType || !entityId || !message)
          throw new Error("entityType, entityId, message are required");

        let externalId: string | null = null;
        if (entityType === "TASK") externalId = (await params.sk.getTask(entityId)).externalId;
        else if (entityType === "WORK_ITEM")
          externalId = (await params.sk.getWorkItem(entityId)).externalId;
        else if (entityType === "PROJECT")
          externalId = (await params.sk.getProject(entityId)).externalId;
        else throw new Error("Invalid entityType: " + entityType);

        const action =
          entityType === "TASK"
            ? "task.comment"
            : entityType === "WORK_ITEM"
              ? "workitem.comment"
              : "project.comment";

        const eventId =
          args.eventId && String(args.eventId).trim()
            ? String(args.eventId).trim()
            : "evt:" + sha256Hex(action + "\n" + entityId + "\n" + message);

        const payload = {
          protocol: "openclaw.superkanban.v1",
          action,
          eventId,
          ts: new Date().toISOString(),
          entity: { kind: entityType, id: entityId, externalId },
          message,
          links: {
            sessionKey: args.sessionKey ? String(args.sessionKey) : null,
            runId: args.runId ? String(args.runId) : null,
          },
        };

        const created = await params.sk.createEvent({ eventId, payload });
        return toolJson("sk_add_comment", { eventId, payload, created });
      },
    }) satisfies AnyAgentTool;
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
      api.logger.warn(
        "[sk-sync] enabled but missing baseUrl (SUPERKANBAN_BASE_URL or SUPER_KANBAN_BASE_URL)",
      );
      return;
    }

    const sk = new SkClient({
      baseUrl: config.baseUrl,
      bearerToken: config.bearerToken,
      apiKey: config.apiKey,
      token: config.token,
      authHeader: config.authHeader,
      authHeaderRead: config.authHeaderRead,
      authHeaderWrite: config.authHeaderWrite,
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

    // Direct SK tools (no skill wrappers)
    api.registerTool(createSkListProjectsTool({ config, sk }));
    api.registerTool(createSkListWorkItemsTool({ config, sk }));
    api.registerTool(createSkListTasksTool({ config, sk }));
    api.registerTool(createSkGetEntityBySessionKeyTool({ config, sk }));
    api.registerTool(createSkListSessionsTool({ config, sk }));
    api.registerTool(createSkGetActiveSessionTool({ config, sk }));
    api.registerTool(createSkUpsertProjectTool({ config, sk }));
    api.registerTool(createSkUpsertWorkItemTool({ config, sk }));
    api.registerTool(createSkUpsertTaskTool({ config, sk }));
    api.registerTool(createSkGetStatusTool({ config, sk }));
    api.registerTool(createSkSetStatusTool({ config, sk }));
    api.registerTool(createSkSetArchivedTool({ config, sk }));
    api.registerTool(createSkAddCommentTool({ config, sk }));

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
      "[sk-sync] registered tools sk_sync_spawn_plugin + sk_* + agent_end/subagent_spawned/subagent_ended hooks",
    );
  },
};

export default plugin;
