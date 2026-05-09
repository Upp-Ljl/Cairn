# Agent presence adapters

Read-only feeders that produce session-presence rows from sources outside
the Cairn MCP `processes` table. Each adapter:

- writes nothing, anywhere (no SQLite, no `~/.claude/`, no `~/.cairn/`);
- emits rows tagged with `source` (provenance) and `confidence` (how
  much we vouch for the data);
- defines its own attribution rule for matching rows to a registered
  project (consumed by `main.cjs` when assembling Sessions / Unassigned).

## Currently shipped

### `claude-code-session-scan.cjs`

Scans `~/.claude/sessions/<pid>.json`, the per-process state file Claude
Code 2.1+ maintains for every interactive session. Status precedence:
no pid → `unknown`; pid not on this host → `dead`; pid alive →
`busy`/`idle` verbatim from the file (any other status falls back to
`unknown`). `updatedAt` is Claude's last-activity stamp, not a
heartbeat — age alone never promotes a row to `stale`; the value is
kept in the status union but is not produced today. Project
attribution: `cwd ⊆ project_root`. Confidence: **medium-high**.

What we cannot see from the session file alone: current tool, prompt
content, subagent topology. Those would require the hooks adapter
(writes to `~/.claude/settings.json`) — explicitly deferred to keep this
step zero-config / zero-touch on the user's existing setup.

### `codex-session-log-scan.cjs`

Scans `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, the
per-session rollout files Codex CLI / Codex Desktop write at session
start and append on every event. The adapter reads ONLY the first line
(the `session_meta` event) and the file's mtime — never per-event
payloads (which contain prompts, tool args, model output, command
stdout/stderr). Status: file mtime within the recent window
(default 60 s) → `recent`; meta parsed but mtime older → `inactive`;
meta missing/unparseable → `unknown`. There is no `busy`/`idle` —
Codex's session_meta carries no current-status field and the meta line
carries no pid, so liveness is unknowable. The adapter deliberately
refuses to fake one. Scan window defaults to the last 7 day-named
subdirectories so we don't traverse the multi-year archive.
Project attribution: `cwd ⊆ project_root`. Confidence: **medium**.

What we cannot see from the rollout file's first line alone: what the
user is currently typing, which tool is running, current model, whether
the Codex Desktop process is still alive. None of those are surfaced.

## Cairn-launched Codex tasks

Separate from this folder. `codex exec --json` emits a JSONL event
stream (`thread.started` / `turn.started` /
`command_execution.item.started` / `turn.completed`). When Cairn
dispatches a Codex run itself, the spawned-process stdout is the
canonical event source. **Confidence: high** for that flow. Adapter
implementation is left for the future "Cairn-launched Codex" wedge —
outside this folder's scope (this folder is host-level presence only).
