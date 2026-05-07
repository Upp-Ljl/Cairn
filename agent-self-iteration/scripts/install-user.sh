#!/usr/bin/env bash
# install-user.sh — make agent-self-iteration's executor + reviewer subagents and
# /auto-iter slash command available to ALL projects, by symlinking them into
# ~/.claude/agents/ and ~/.claude/commands/.
#
# What's installed (with `auto-iter-` prefix to avoid namespace collisions):
#   ~/.claude/agents/auto-iter-profiler.md
#   ~/.claude/agents/auto-iter-executor.md
#   ~/.claude/agents/auto-iter-reviewer.md
#   ~/.claude/commands/auto-iter.md
#
# What's NOT installed (kept project-local — they exist to evolve THIS tool):
#   self-improver subagent
#   /self-improve command
#   regression suite
#
# Usage:
#   ./scripts/install-user.sh              # symlink (default; updates flow when source changes)
#   ./scripts/install-user.sh --copy       # hard copy instead of symlink (immutable snapshot)
#   ./scripts/install-user.sh --remove     # uninstall
#   ./scripts/install-user.sh --status     # show what's installed, where it points

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_AGENTS="$HOME/.claude/agents"
USER_COMMANDS="$HOME/.claude/commands"

# (source path → destination basename) for each artifact installed.
ARTIFACTS=(
  "$ROOT/.claude/agents/profiler.md|$USER_AGENTS/auto-iter-profiler.md"
  "$ROOT/.claude/agents/executor.md|$USER_AGENTS/auto-iter-executor.md"
  "$ROOT/.claude/agents/reviewer.md|$USER_AGENTS/auto-iter-reviewer.md"
  "$ROOT/.claude/commands/auto-iter.md|$USER_COMMANDS/auto-iter.md"
)

mode="${1:-link}"
case "$mode" in
  --copy) mode="copy" ;;
  --remove) mode="remove" ;;
  --status) mode="status" ;;
  ""|--link) mode="link" ;;
  *) echo "unknown flag: $mode (use --copy / --remove / --status)" >&2; exit 2 ;;
esac

mkdir -p "$USER_AGENTS" "$USER_COMMANDS"

show_target() {
  # Print "<path> -> <symlink-target>" or "<path> (file)" or "<path> (missing)"
  local path="$1"
  if [ -L "$path" ]; then
    echo "  $path -> $(readlink "$path")"
  elif [ -e "$path" ]; then
    echo "  $path (regular file, not a symlink)"
  else
    echo "  $path (missing)"
  fi
}

case "$mode" in
  status)
    echo "agent-self-iteration user-level install status:"
    for entry in "${ARTIFACTS[@]}"; do
      dst="${entry##*|}"
      show_target "$dst"
    done
    ;;

  remove)
    for entry in "${ARTIFACTS[@]}"; do
      src="${entry%|*}"
      dst="${entry##*|}"
      if [ -L "$dst" ]; then
        rm "$dst"
        echo "removed symlink $dst"
      elif [ -e "$dst" ]; then
        # Only remove regular file if its content matches our source — never delete
        # something the user might have authored independently.
        if cmp -s "$src" "$dst" 2>/dev/null; then
          rm "$dst"
          echo "removed file $dst (content matched source)"
        else
          echo "skipped $dst (regular file with different content — leave for the user)"
        fi
      fi
    done
    ;;

  link|copy)
    for entry in "${ARTIFACTS[@]}"; do
      src="${entry%|*}"
      dst="${entry##*|}"
      if [ ! -f "$src" ]; then
        echo "ERROR: source not found: $src" >&2
        exit 1
      fi
      # Refuse to clobber a non-symlink, non-matching file (user authored).
      if [ -e "$dst" ] && [ ! -L "$dst" ]; then
        if ! cmp -s "$src" "$dst" 2>/dev/null; then
          echo "ERROR: $dst exists and is not from this tool. Aborting to protect your data." >&2
          echo "       Inspect it, move it aside, then re-run." >&2
          exit 1
        fi
      fi
      rm -f "$dst"
      if [ "$mode" = "link" ]; then
        ln -s "$src" "$dst"
        echo "linked $dst -> $src"
      else
        cp "$src" "$dst"
        echo "copied $src -> $dst"
      fi
    done
    echo
    echo "Done. From any project: \`cd <project> && claude\`, then \`/auto-iter . | <task>\`."
    ;;
esac
