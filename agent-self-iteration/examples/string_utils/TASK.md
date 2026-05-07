Make every test in `tests/test_strings.py` pass.

Constraints:
- Do NOT modify the tests. They are the spec.
- Keep `src/strings.py` simple. Standard library only — no new dependencies.
- All four functions (`slugify`, `truncate`, `word_count`, `is_palindrome`) must satisfy their tests.

Hint (do not rely on this — read the tests):
- `slugify` should lowercase and strip non-alphanumeric characters before joining with dashes.
- `truncate(text, limit)` must return a string of length <= `limit`, including any ellipsis.
- `word_count` should not count empty splits from extra whitespace.
- `is_palindrome` should ignore case, whitespace, and punctuation.
