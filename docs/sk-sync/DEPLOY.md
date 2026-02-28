# SK-Sync — Deploy + Smoke Test

This document describes how to deploy the SK-Sync path (Super‑Kanban ↔ OpenClaw) and run a minimal smoke test.

> NOTE: Applying these changes typically requires restarting services (Super‑Kanban and/or OpenClaw Gateway). Do **not** restart without explicit approval.

## Prerequisites

- Super‑Kanban deployed with SK-Sync API additions:
  - `GET /api/sessions/resolve?sessionKey=...`
  - `POST /api/tasks/:taskId/lock`
  - `POST /api/tasks/:taskId/unlock`
  - session list endpoints accept `WRITE_INTEGRATION` scope for reuse (`/api/projects/:id/sessions`, `/api/work-items/:id/sessions`, `/api/tasks/:id/sessions`)
- OpenClaw deployed with plugin tool context session helpers (this repo change):
  - plugin tools receive `ctx.openclaw.sessionsSpawn()` and `ctx.openclaw.sessionsSend()`.

## Install the SK-Sync plugin (local)

The plugin is intended to live in:

- `~/.openclaw/extensions/sk-sync/`

Contents (minimum):

- `openclaw.plugin.json`
- `index.ts`

Enable it via config (example):

```jsonc
{
  "plugins": {
    "sk-sync": {
      "enabled": true,
      "baseUrl": "https://<super-kanban-host>/api",
      "token": "<WRITE_INTEGRATION token>",
      "timeoutMs": 10000,
      "taskLockTtlSeconds": 3600,
    },
  },
}
```

Environment variable alternatives:

- `SUPER_KANBAN_BASE_URL`
- `SUPER_KANBAN_TOKEN`

## Optional rollout guardrail (hide sessions_spawn)

After SK‑Sync is validated, consider restricting direct access to `sessions_spawn` for higher-level agents (main/orion/atlas) and promoting `sk_sync_spawn`.

Implementation detail: use OpenClaw tool policy configuration (denylist) for those agents and allow `sk_sync_spawn` via plugin.

## Smoke test

### 1) Create Project + Work Item + Task in SK (via SK‑Sync)

From an agent session, call:

- level `ORION` with `projectExternalId` (e.g. `project:demo`)
- level `ATLAS` with `workItemExternalId` (e.g. `workitem:demo:wi1`)
- level `WORKER` with `taskExternalId` (e.g. `task:demo:wi1:t1`)

Expected:

- Entities are upserted in Super‑Kanban with `externalSystem=OPENCLAW` and the provided `externalId`.
- An execution session is attached to the correct entity type.
- For WORKER, the Task becomes `IN_PROGRESS` immediately.

### 2) Verify lock behavior

Attempt two WORKER spawns for the same `taskId` concurrently.

Expected:

- First call acquires lock (200) and spawns.
- Second call fails with `409 CONFLICT` until lock is released or expires.

### 3) Verify completion updates

When the worker subagent finishes:

Expected:

- Task execution session state changes to `DONE`/`FAILED`/`CANCELLED`.
- Task status becomes `DONE` (ok) or `BLOCKED` (error/timeout) or `CANCELLED`.
- Lock is released.

### 4) Verify Orion/Atlas session reuse

Call `sk_sync_spawn` again for the same Project/Work Item.

Expected:

- The existing sessionKey is reused via `sessions_send`.
- In SK, the same execution session remains attached (logical persistent session).

## Troubleshooting

- If the plugin reports missing `ctx.openclaw.sessionsSpawn/sessionsSend`, OpenClaw core is not updated to a build that includes the plugin session helpers.
- If Super‑Kanban returns 403, verify your token is included in Super‑Kanban env:
  - `SUPER_KANBAN_WRITE_INTEGRATION_TOKENS` contains the token.
- If lock endpoints 404, Super‑Kanban deploy is missing the task locks migration.
