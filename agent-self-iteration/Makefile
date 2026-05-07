.PHONY: help install install-copy uninstall status regression self-test smoke

help:
	@echo "agent-self-iteration — make targets"
	@echo ""
	@echo "  make install       Symlink executor/reviewer subagents and /auto-iter"
	@echo "                     into ~/.claude/. Updates flow when source changes."
	@echo "  make install-copy  Hard-copy instead of symlink (frozen snapshot)."
	@echo "  make uninstall     Remove the user-level install."
	@echo "  make status        Show what's installed and where it points."
	@echo ""
	@echo "  make regression    Run the regression suite (costs API/Pro tokens)."
	@echo "  make self-test     Quick smoke: ensure all .md files parse and links work."
	@echo "  make smoke         Stub-driven smoke test of dual_agent_iter.sh (no API cost)."

install:
	@bash scripts/install-user.sh

install-copy:
	@bash scripts/install-user.sh --copy

uninstall:
	@bash scripts/install-user.sh --remove

status:
	@bash scripts/install-user.sh --status

regression:
	@bash scripts/regression.sh

smoke:
	@bash scripts/smoke_test_driver.sh

self-test:
	@bash -n scripts/install-user.sh && echo "install-user.sh: syntax OK"
	@bash -n scripts/regression.sh && echo "regression.sh: syntax OK"
	@bash -n scripts/dual_agent_iter.sh && echo "dual_agent_iter.sh: syntax OK"
	@test -f .claude/agents/executor.md && echo "executor.md: present"
	@test -f .claude/agents/reviewer.md && echo "reviewer.md: present"
	@test -f .claude/agents/profiler.md && echo "profiler.md: present"
	@test -f .claude/agents/self-improver.md && echo "self-improver.md: present"
	@test -f .claude/commands/auto-iter.md && echo "auto-iter.md: present"
	@test -f .claude/commands/self-improve.md && echo "self-improve.md: present"
	@test -f docs/INVARIANTS.md && echo "INVARIANTS.md: present"
	@test -f templates/.auto-iter.yml.example && echo ".auto-iter.yml.example: present"
	@test -f examples/buggy_calculator/.baseline-src/calc.py && echo "buggy_calculator baseline: present"
	@test -f examples/string_utils/.baseline-src/strings.py && echo "string_utils baseline: present"
