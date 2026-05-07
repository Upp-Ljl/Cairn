"""Minimal CSV parser.

Buggy baseline: this implementation only handles the simplest case --
comma-split each line, newline-split the input. It does not handle:
  - quoted fields containing commas
  - escaped quotes ("") inside quoted fields
  - embedded newlines inside quoted fields
  - CRLF line endings
  - trailing newline (it produces a spurious empty row)
  - empty input (it returns [[""]] instead of [])

The fix is NOT a one-liner. A correct implementation typically becomes a
small character-by-character state machine (in-quote vs out-of-quote).
"""


def parse_csv(text):
    rows = []
    for line in text.split("\n"):
        rows.append(line.split(","))
    return rows
