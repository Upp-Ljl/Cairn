Make every test in `tests/run_tests.sh` pass.

The script `src/deploy.sh` takes a single string argument and is supposed to:
- Split it on whitespace, deduplicate the words, sort them, and print one per line.
- Print a usage message when called with `--help` and exit 0.
- Exit with non-zero status (and a stderr message) when called with no argument
  or an empty string.
- Handle inputs that begin with `-` (e.g. `-foo`) without treating them as
  options.

Constraints:
- Do NOT modify `tests/run_tests.sh`. They are the spec.
- Stay in pure bash; no awk/perl/python helpers required.
- Use `set -euo pipefail` defensively.

Hint (don't rely on this — read the tests):
- `echo $var` strips leading dashes and is generally fragile; prefer `printf '%s\n' "$var"`.
- `sort -u` deduplicates while sorting.
- `[ -z "$1" ]` won't trigger if the script was invoked with no args at all
  under `set -u` — handle the no-arg case before referencing `$1`.
