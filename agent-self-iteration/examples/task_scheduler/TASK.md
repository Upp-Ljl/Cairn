Make every test in `tests/test_scheduler.py` pass.

The module exposes:
- `schedule(spec: dict) -> list[list[str]]`
- `CycleError` (exception class)

A `spec` maps task names to `{"deps": [str, ...], "priority": int}`. The
function returns "rounds": each round is a list of task names that can run
in parallel because all their deps are in earlier rounds.

The tests are the spec. Read them for the exact ordering rules, error
cases, and edge cases. Some behaviors (e.g. self-loops, disconnected
components, empty input, undeclared deps) are subtle — the tests are
authoritative.

Constraints:
- Do NOT modify the tests.
- `src/scheduler.py` should remain a single file.
- Standard library only. No new dependencies.
