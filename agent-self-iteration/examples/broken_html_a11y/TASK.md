Make every check in `tests/check_a11y.mjs` pass when run against `src/page.html`.

The HTML page in `src/page.html` has multiple accessibility (a11y) violations.
The static analyzer in `tests/check_a11y.mjs` enforces a small set of rules
common to web a11y guidelines (WCAG-flavored, but mechanically simpler):

1. The `<html>` tag must declare a `lang` attribute.
2. The `<head>` must contain exactly one non-empty `<title>`.
3. Every `<img>` must have an `alt` attribute (empty string `alt=""` is OK
   for purely decorative images, but the attribute itself must be present).
4. Every `<button>` must have either non-whitespace text content or an
   `aria-label` / `aria-labelledby` attribute.
5. Every `<input>` must have an associated `<label for="...">` (matching by
   `id`) OR an `aria-label` / `aria-labelledby` attribute.
6. Any `<div>`, `<span>`, or `<p>` element with an `onclick` handler must
   also declare `role="button"` and `tabindex="0"` AND an `onkeydown` /
   `onkeyup` / `onkeypress` handler (i.e. be keyboard-reachable, not just
   mouse-clickable).
7. Color-contrast and semantic-structure checks are out of scope; only the
   six rules above are mechanically enforced.

Constraints:
- Do NOT modify `tests/check_a11y.mjs`. It is the spec.
- Keep the page semantically equivalent — fix the a11y issues, don't gut
  the page.
- Stay in vanilla HTML; do not introduce a build step or framework.

Hint:
- Read the test file to see exactly which DOM patterns are detected and how.
- The checker uses simple regex/string scanning, not a real HTML parser, so
  attribute order and casing matter less — but every required attribute must
  be present and non-empty.
