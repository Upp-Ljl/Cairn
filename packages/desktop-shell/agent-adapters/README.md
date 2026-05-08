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
`dead` (pid gone) → `stale` (`updated_at` older than 90 s) →
`busy`/`idle` verbatim from the file. Project attribution: `cwd ⊆
project_root`. Confidence: **medium-high**.

What we cannot see from the session file alone: current tool, prompt
content, subagent topology. Those would require the hooks adapter
(writes to `~/.claude/settings.json`) — explicitly deferred to keep this
step zero-config / zero-touch on the user's existing setup.

## Codex CLI / Codex Desktop status

Two distinct cases, neither delivered in this round:

1. **Cairn-launched Codex tasks** — already validated outside this
   adapter folder: `codex exec --json` emits a JSONL event stream
   (`thread.started` / `turn.started` / `command_execution.item.started`
   / `turn.completed`). When Cairn dispatches a Codex run itself, the
   spawned-process stdout is the canonical event source. **Confidence:
   high** for that flow. Adapter implementation is left for the future
   "Cairn-launched Codex" wedge — outside this round's scope.

2. **Existing Codex Desktop sessions (user-initiated)** — at the time
   of writing, Codex Desktop has **no host-level equivalent** of
   `~/.claude/sessions/<pid>.json`. The only host-visible signal for
   an already-running Codex is the `codex` / `node` process in the OS
   process list, which carries no `cwd` or per-session id information.
   Building an adapter on top of OS process scan alone is **low
   confidence**: it would tell the panel "a Codex is running somewhere"
   without a project to attribute it to. We deliberately do not ship
   that — it's worse than no row, because users would assume the row
   means more than it does. If we add a Codex adapter later it must
   tag itself `source="codex/process-scan"`, `confidence="low"`, and
   skip project attribution unless a reliable cwd surface emerges
   (Codex Desktop adding a session file, an opt-in self-report
   plugin, or a future app-server protocol).

These notes mirror the trade-off in the upstream presence-adapter
investigation that produced this folder. Keep them in sync if the
Codex side gains a session file.
