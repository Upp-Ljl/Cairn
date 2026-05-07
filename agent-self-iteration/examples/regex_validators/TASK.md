Make every test in `tests/test_validators.py` pass.

The module exposes four pure functions:
- `is_valid_email(s: str) -> bool` — true iff `s` is a single, complete email
  address (no leading/trailing junk, no embedded whitespace).
- `is_valid_ipv4(s: str) -> bool` — true iff `s` is a dotted-quad with each
  octet in [0, 255], no leading zeros (e.g. "01.2.3.4" is invalid), and no
  surrounding whitespace.
- `is_hex_color(s: str) -> bool` — true iff `s` is `#` followed by exactly
  3 or 6 hexadecimal digits (case-insensitive); other lengths invalid.
- `extract_mentions(text: str) -> list[str]` — return all `@username`
  mentions (without the `@`) in left-to-right order. Username = letters,
  digits, and underscore, length 1–15. A mention is only valid if the
  `@` is at the start of the text or preceded by whitespace (so emails
  like `me@example.com` do NOT yield "example").

Constraints:
- Do NOT modify the tests. They are the spec.
- Standard library only (`re` is fine).
- `src/validators.py` should remain a single file.

These bugs are subtle: each function "looks right" by inspection (the regex
even compiles and matches the obvious cases) but fails on adversarial inputs
that the tests deliberately probe — anchoring confusion, leading-zero
handling, length bounds, and word-boundary placement. You will need to
actually run the tests to see which functions are wrong, and re-run after
each edit. Do not declare done by inspection.
