# Using `/auto-iter` on other projects

This document is for the **consumer** workflow: using the executor + reviewer
loop as an auxiliary tool on any project (not the self-improvement loop, which
stays inside this repo).

## One-time install

From this repo's root:

```bash
make install
```

This symlinks three files into your user-level Claude Code config:

| Source (in this repo)               | Destination (`~/.claude/`)              |
|-------------------------------------|------------------------------------------|
| `.claude/agents/executor.md`        | `agents/auto-iter-executor.md`           |
| `.claude/agents/reviewer.md`        | `agents/auto-iter-reviewer.md`           |
| `.claude/commands/auto-iter.md`     | `commands/auto-iter.md`                  |

Symlinks mean: any future improvement you commit to this repo's prompts flows
out to every project automatically. Run `make install-copy` instead if you want
a frozen snapshot (no auto-update).

`make uninstall` removes the symlinks. It refuses to delete files that don't
match the source — your other Claude Code customizations are safe.

## Per-project setup (any consumer project)

In the project where you want to run `/auto-iter`:

```bash
cd ~/path/to/your/project
cp ~/path/to/agent-self-iteration/templates/.auto-iter.yml.example .auto-iter.yml
$EDITOR .auto-iter.yml   # set signals + safety knobs for this project
```

Key fields:

- **`signals`** — commands that get run after every iteration. Non-zero exit
  forces verdict=fail. For a Node project: `tests: npm test`. Go: `go test ./...`.
  Cargo: `cargo test`.
- **`allowed_paths` / `forbidden_paths`** — globs that constrain executor edits.
  Always exclude `.env*`, secret dirs, and migrations.
- **`working_branch`** — auto-create a branch per task. Default
  `auto-iter/{slug}` keeps every run isolated from `main`.
- **`forbidden_branches`** — refuse to run on `main`/`master`/`production`.

If `.auto-iter.yml` is absent, the slash command falls back to auto-detection:
`pyproject.toml`/`setup.py` → pytest, `package.json` → `npm test`, etc. For
predictable behavior, declare the file.

## Running

```bash
cd ~/path/to/your/project
claude --dangerously-skip-permissions     # (or --permission-mode acceptEdits)
```

Inside Claude Code:

```
/auto-iter . | login flow logs out users after page refresh — fix it
```

Workflow:
1. Orchestrator reads `.auto-iter.yml`, refuses if on a forbidden branch.
2. Creates `auto-iter/login-flow-logs-out-users` branch from current HEAD.
3. Loops executor + signals + reviewer until convergence (or max iterations).
4. Prints a final diff stat and leaves you on the new branch for review.
5. Merge the branch yourself once you've inspected the changes.

## Safety model

The consumer-mode safety rails are stricter than the self-improvement loop:

| Rail | Behavior |
|------|----------|
| Auto-branch | Every run lives on `auto-iter/<slug>`; `main` is never edited |
| Forbidden branches | Hard refusal, no `--force` flag |
| Blast radius | `allowed_paths` / `forbidden_paths` enforced per executor dispatch |
| Diff cap | If total changes exceed `max_diff_lines`, abort + force fail |
| Clean worktree | Refuses to start with uncommitted changes (no auto-stash) |
| Final report | `git diff --stat <base>...HEAD` shown for human review |

## What's NOT installed at user level

- `/self-improve` — meta-loop that evolves the executor/reviewer prompts;
  only meaningful inside this source repo.
- `auto-iter-self-improver` subagent — same reason.
- `scripts/regression.sh` and `examples/` — the regression suite that scores
  prompt changes. Tied to the source repo.

These can be invoked only when `cwd` is inside this repo. Consumer projects see
just `executor`, `reviewer`, and `/auto-iter`.

## Updating the prompts

Improvements to the executor or reviewer happen in this source repo:

1. Edit `.claude/agents/executor.md` or `.claude/agents/reviewer.md` (manually,
   or via `/self-improve` running its meta-loop).
2. Commit. Symlinks at user level point at these files, so the next
   `/auto-iter` invocation in any project picks up the new prompts immediately.
3. To pin a project to a specific prompt version, `make install-copy` instead
   of `make install` — that snapshot won't auto-update.

## Troubleshooting

**`/auto-iter` doesn't appear in slash command completion**

Run `make status` in this repo. Should show three symlinks. If any are missing,
`make install` again. If any show `regular file, not a symlink`, you have a
hand-authored file with the same name — move it aside and reinstall.

**The orchestrator refuses to start: "current branch is forbidden"**

You're on `main` (or whatever you listed in `forbidden_branches`). Either
`git checkout -b feature/foo` first, or remove that branch from the forbidden
list (only do this if you really mean it).

**Executor edited a file outside `allowed_paths`**

The orchestrator should reject this and force the iteration to fail. If it
slipped through, check the executor's prompt — it may need stronger blast-
radius language. File an issue against this repo (or, ironically, run
`/self-improve` to fix it).
