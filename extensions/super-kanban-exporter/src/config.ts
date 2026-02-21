export type SuperKanbanExporterConfig = {
  enabled: boolean;

  /** Base URL, e.g. https://super-kanban.example.com/api */
  baseUrl?: string;

  /** If set, sent as Authorization: Bearer <token> unless authHeader is set. */
  token?: string;

  /** If set, sent as-is (e.g. "X-Api-Key: ..." or "Authorization: Bearer ..."). */
  authHeader?: string;

  attachPath: string;
  messagesPath: string;
  toolCallsPath: string;

  pollIntervalMs: number;
  debounceMs: number;
  timeoutMs: number;

  maxTextChars: number;
  maxToolResultChars: number;

  /** Optional list of agent IDs (folder names under stateDir/agents) to export. */
  agentsAllowlist?: string[];
};

export type SuperKanbanExporterPluginConfig = Partial<{
  enabled: unknown;
  baseUrl: unknown;
  token: unknown;
  authHeader: unknown;
  attachPath: unknown;
  messagesPath: unknown;
  toolCallsPath: unknown;
  pollIntervalMs: unknown;
  debounceMs: unknown;
  timeoutMs: unknown;
  maxTextChars: unknown;
  maxToolResultChars: unknown;
  agentsAllowlist: unknown;
}>;

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") {
      return true;
    }
    if (v === "false" || v === "0" || v === "no" || v === "off") {
      return false;
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    const v = asString(entry);
    if (v) {
      out.push(v);
    }
  }
  return out.length ? out : undefined;
}

function normalizePath(value: string | undefined, fallback: string): string {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

export const superKanbanExporterConfigSchema = {
  parse(value: unknown): SuperKanbanExporterPluginConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as SuperKanbanExporterPluginConfig;
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      baseUrl: { type: "string" },
      token: { type: "string" },
      authHeader: { type: "string" },
      attachPath: { type: "string" },
      messagesPath: { type: "string" },
      toolCallsPath: { type: "string" },
      pollIntervalMs: { type: "number" },
      debounceMs: { type: "number" },
      timeoutMs: { type: "number" },
      maxTextChars: { type: "number" },
      maxToolResultChars: { type: "number" },
      agentsAllowlist: { type: "array", items: { type: "string" } },
    },
  },
};

export function resolveSuperKanbanExporterConfig(
  pluginConfig: SuperKanbanExporterPluginConfig,
  env: NodeJS.ProcessEnv = process.env,
): SuperKanbanExporterConfig {
  const enabled =
    asBool(pluginConfig.enabled) ??
    asBool(env.SUPER_KANBAN_ENABLED) ??
    asBool(env.OPENCLAW_SUPER_KANBAN_ENABLED) ??
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

  const attachPath = normalizePath(
    asString(pluginConfig.attachPath) ?? asString(env.SUPER_KANBAN_ATTACH_PATH),
    "/sessions/attach",
  );
  const messagesPath = normalizePath(
    asString(pluginConfig.messagesPath) ?? asString(env.SUPER_KANBAN_MESSAGES_PATH),
    "/messages/record",
  );
  const toolCallsPath = normalizePath(
    asString(pluginConfig.toolCallsPath) ?? asString(env.SUPER_KANBAN_TOOL_CALLS_PATH),
    "/tool-calls/record",
  );

  const pollIntervalMs = Math.max(
    250,
    Math.floor(
      asNumber(pluginConfig.pollIntervalMs) ?? asNumber(env.SUPER_KANBAN_POLL_INTERVAL_MS) ?? 1000,
    ),
  );
  const debounceMs = Math.max(
    0,
    Math.floor(asNumber(pluginConfig.debounceMs) ?? asNumber(env.SUPER_KANBAN_DEBOUNCE_MS) ?? 250),
  );
  const timeoutMs = Math.max(
    500,
    Math.floor(asNumber(pluginConfig.timeoutMs) ?? asNumber(env.SUPER_KANBAN_TIMEOUT_MS) ?? 8000),
  );

  const maxTextChars = Math.max(
    0,
    Math.floor(
      asNumber(pluginConfig.maxTextChars) ?? asNumber(env.SUPER_KANBAN_MAX_TEXT_CHARS) ?? 8000,
    ),
  );

  const maxToolResultChars = Math.max(
    0,
    Math.floor(
      asNumber(pluginConfig.maxToolResultChars) ??
        asNumber(env.SUPER_KANBAN_MAX_TOOL_RESULT_CHARS) ??
        8000,
    ),
  );

  const agentsAllowlist =
    asStringArray(pluginConfig.agentsAllowlist) ??
    asString(env.SUPER_KANBAN_AGENTS_ALLOWLIST)
      ?.split(",")
      .map((v) => v.trim())
      .filter(Boolean) ??
    undefined;

  return {
    enabled,
    baseUrl,
    token,
    authHeader,
    attachPath,
    messagesPath,
    toolCallsPath,
    pollIntervalMs,
    debounceMs,
    timeoutMs,
    maxTextChars,
    maxToolResultChars,
    agentsAllowlist,
  };
}
