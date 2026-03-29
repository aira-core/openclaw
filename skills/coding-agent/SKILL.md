---
name: coding-agent
description: 'Delegate non-trivial coding tasks to Codex, Claude Code, OpenCode, or Pi via exec/process. Use when: (1) building or changing features, (2) reviewing PRs in an isolated checkout/worktree, (3) refactoring larger codebases, (4) iterative repo work that benefits from an external coding agent. On this host, when the runner is local Codex and the task is automated or non-interactive, prefer ~/.local/bin/openclaw-codex-launch with an explicit profile instead of raw `codex exec` or global profile activators. NOT for: simple one-line edits (edit directly), read-only file inspection, explicit thread-bound ACP harness requests in chat (use `sessions_spawn` with `runtime:"acp"`), or any work in ~/clawd workspace. Completion notifications for delegated work must use openclaw message send, not system event/heartbeat.'
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "requires":
          {
            "anyBins": ["claude", "codex", "opencode", "pi"],
            "config": ["skills.entries.coding-agent.enabled"],
          },
        "install":
          [
            {
              "id": "node-claude",
              "kind": "node",
              "package": "@anthropic-ai/claude-code",
              "bins": ["claude"],
              "label": "Install Claude Code CLI (npm)",
            },
            {
              "id": "node-codex",
              "kind": "node",
              "package": "@openai/codex",
              "bins": ["codex"],
              "label": "Install Codex CLI (npm)",
            },
          ],
      },
  }
---

# Coding Agent

Use coding agents for multi-step repo work. Do not delegate trivial edits you can safely make yourself.

## Choose the path

1. **Simple one-liner or tiny direct fix**
   - Edit directly.
   - Do not spawn a coding agent just to change one obvious line.

2. **Local Codex, automated or non-interactive task on this host**
   - Preferred path: `~/.local/bin/openclaw-codex-launch`.
   - Use an explicit profile (`codexA` or `codexB`) and optional single fallback profile.
   - This is the canonical `direct-cli` path for `codex-operator` on this host.
   - Do **not** default to raw `codex exec` or global activators like `codexA_activate` / `codexB_activate`.

3. **Local Codex, interactive TUI exception**
   - Use `codexA` or `codexB` directly.
   - Treat this as a manual exception, not the normal multiworker path.

4. **Claude Code**
   - Use `claude --permission-mode bypassPermissions --print ...`.
   - No PTY required.

5. **Pi / OpenCode**
   - Use `exec` with `pty:true`.

6. **Explicit ACP harness request in chat**
   - Do not use this skill path.
   - Use `sessions_spawn` with `runtime:"acp"` and the requested harness.

## Canonical launcher usage for local Codex

### Preflight

```bash
~/.local/bin/openclaw-codex-launch \
  --profile codexA \
  --fallback-profile codexB \
  --workdir /path/to/repo \
  --preflight-only
```

### Typical automated run

```bash
~/.local/bin/openclaw-codex-launch \
  --profile codexA \
  --fallback-profile codexB \
  --workdir /path/to/repo \
  -- exec --json "Your task"
```

### Background run via tools

- Use `exec` with a sensible `yieldMs` first.
- Only use `background:true` when the task is expected to outlive the first wait window.
- After backgrounding, inspect with `process.log` or `process.poll` **on demand**.
- Do **not** normalize 1-second polling loops or aggressive scraping.

## PTY rules

- **Codex / Pi / OpenCode**: use `pty:true` when running the raw interactive CLI.
- **Claude Code**: no PTY required in `--print` mode.
- `openclaw-codex-launch` is for automated/non-interactive Codex runs; prefer it over raw PTY Codex when it fits.

## Notification route

When you delegate work that may finish after your current reply, capture the real completion route before spawning:

- `notifyChannel`
- `notifyTarget`
- `notifyAccount` when applicable
- `notifyReplyTo` when replying to a specific message is desired
- `notifyThreadId` for Telegram topics or Slack threads when applicable

Do not rely on:

- `openclaw system event`
- `tools.exec.notifyOnExit`
- heartbeat delivery
- `HEARTBEAT.md`

Use a direct outbound completion message instead:

```bash
openclaw message send --channel <channel> --target '<target>' --message '<text>'
```

Add optional routing flags only when they are real and applicable:

- `--account <id>`
- `--reply-to <messageId>`
- `--thread-id <threadId>`

### Completion prompt snippet

Append this shape to worker prompts when the worker is expected to self-report:

```text
Notification route for completion:
- channel: <notifyChannel>
- target: <notifyTarget>
- account: <notifyAccount or omit>
- reply_to: <notifyReplyTo or omit>
- thread_id: <notifyThreadId or omit>

When the task is completely finished, send exactly one completion message back to the user with openclaw message send using that route.
If the task fails fatally, send exactly one failure message back to the user with openclaw message send using that route.
Do not use openclaw system event. Do not rely on heartbeat. Do not skip the completion/failure message.
```

## Monitoring discipline

- Prefer one short foreground run over a long background run when possible.
- If backgrounded, report when something material changes, not every few seconds.
- Use `process.log` for evidence and `process.poll` to learn whether the session is still alive.
- Avoid nervous watchdog patterns unless the task explicitly requires tight supervision.
- If you do not have a trustworthy notification route, say so and do not claim that completion will notify the user automatically.

## Reporting semantics

- **DONE**: only when the requested scope is terminally closed.
- **STATUS**: use when meaningful work happened but a material step is still pending.
- Pending publish, verify, external input, approval, or another material handoff means **not DONE yet**.
- **BLOCKED**: use when progress requires a decision, permission, missing credential, or external system change.

## Artifact semantics

State artifact status explicitly:

- **local artifact ready**: built locally and available on disk, not yet published/verified externally.
- **published artifact verified**: published to the intended destination and verified from that destination.

Do not collapse those into the same claim.

## Public deliverable contract

If the request is for an installable/public deliverable such as **“APK lista para instalar”**, the minimum contract is:

1. version bump / release version chosen
2. build completed
3. artifact published or placed in the target delivery surface
4. external/public verification from that surface

If one of those is intentionally out of scope, say so explicitly and report **STATUS** rather than **DONE**.

## Safe examples

### Codex launcher run

```bash
exec command:"~/.local/bin/openclaw-codex-launch --profile codexA --fallback-profile codexB --workdir /repo -- exec --json 'Review the diff and summarize risks'" workdir:"/repo" yieldMs:30000
```

### Raw Codex interactive run

```bash
exec command:"codex exec 'Review the diff and summarize risks'" workdir:"/repo" pty:true yieldMs:30000
```

### Claude Code run

```bash
exec command:"claude --permission-mode bypassPermissions --print 'Review the diff and summarize risks'" workdir:"/repo" yieldMs:30000
```

### Pi run

```bash
exec command:"pi 'Refactor the failing tests'" workdir:"/repo" pty:true yieldMs:30000
```

## Guardrails

- Never run coding agents in `~/clawd`.
- Never start Codex inside the OpenClaw state directory (`$OPENCLAW_STATE_DIR`, default `~/.openclaw`).
- For PR review, use an isolated clone or worktree when the main checkout should stay clean.
- Keep one writer per repo/worktree.
- Prefer short prompts that ask for concrete diffs, commands, and paths.
- Respect explicit tool choice: if the user asks for Codex, use Codex.
- If an agent fails or stalls, report the failure class or concrete blocker instead of silently taking over.
