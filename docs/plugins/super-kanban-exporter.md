# Super-Kanban Exporter (and Reconciler)

This plugin streams OpenClaw session transcripts (messages + tool call events) to **Super‑Kanban** and provides a CLI **reconciler** to detect/export drift.

## Enable the exporter

Add the plugin to your OpenClaw config and enable it:

```jsonc
{
  "plugins": {
    "enabled": ["super-kanban-exporter"],
    "config": {
      "super-kanban-exporter": {
        "enabled": true,
        "baseUrl": "https://super-kanban.example.com/api",
        "token": "...",
      },
    },
  },
}
```

Environment variable alternatives:

- `SUPER_KANBAN_BASE_URL`
- `SUPER_KANBAN_TOKEN` (or `SUPER_KANBAN_AUTH_HEADER`)

Routing is driven by the session label:

- Direct: `SK:TASK:<externalId>` (or `SK:WORK_ITEM:<externalId>`, `SK:PROJECT:<externalId>`)
- Hashed task routing (when externalId is too long): `SK:TASKH:<sha256(externalId)[0:16]>`

For hashed routing, the exporter/reconciler resolves the real externalId from:

- `Exports/label-map.json` (default), or
- transcript scan (best-effort, and appends to `label-map.json` on `--fix`).

## Reconciler CLI

The reconciler re-reads local transcripts and **replays idempotent**:

- `sessions/attach`
- `messages/record`
- `tool-calls/record`

This is meant to repair drift when:

- the exporter was disabled/misconfigured during a run,
- session labels were added later (binding previously failed), or
- events need to be re-sent safely.

### Dry-run (default)

```bash
openclaw super-kanban reconcile
```

### Apply fixes

```bash
openclaw super-kanban reconcile --fix
```

### Useful filters

```bash
# Only one agent
openclaw super-kanban reconcile --agent main

# Only one sessionId
openclaw super-kanban reconcile --session-id <sessionId>

# Only one sessionKey
openclaw super-kanban reconcile --session-key <sessionKey>
```

### Endpoint/config overrides

```bash
openclaw super-kanban reconcile \
  --base-url https://super-kanban.example.com/api \
  --token "$SUPER_KANBAN_TOKEN"
```

### Output formats

- Human text output (default)
- JSON:

```bash
openclaw super-kanban reconcile --json
```
