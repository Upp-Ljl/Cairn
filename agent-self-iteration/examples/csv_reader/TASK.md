Make every test in `tests/test_csv_reader.py` pass.

The module exposes one function:
- `parse_csv(text: str) -> list[list[str]]` — parse RFC-4180-ish CSV text into a
  list of rows, each row a list of string fields.

Constraints:
- Do NOT modify the tests. They are the spec.
- Standard library only. Do NOT import the `csv` module — the point is to
  implement parsing, not delegate. Tests import `parse_csv` directly.
- `src/csv_reader.py` should remain a single file.

Required behaviours (read the tests for exact cases):
- Comma-separated fields, simple rows.
- Double-quoted fields may contain commas without splitting.
- Inside a quoted field, two consecutive double-quotes (`""`) represent one
  literal `"` character.
- Quoted fields may contain embedded newlines (`\n` and/or `\r\n`); those
  newlines are part of the field, not row terminators.
- Row terminators outside quotes are `\n` or `\r\n` (treat both as one row break).
- A trailing newline after the last row does NOT produce an extra empty row.
- An empty input string yields `[]`.
