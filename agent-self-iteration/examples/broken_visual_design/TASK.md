# TASK: improve the visual design of the landing page

`src/index.html` and `src/style.css` make up a marketing landing page
for a fictional product. The page renders, but the visual design is
deliberately broken — the visual hierarchy is inverted (the company
name is small and gray, while a generic eyebrow is enormous and
cyan), the palette clashes (hotpink-yellow-lime gradient + yellow CTA
+ cyan eyebrow), spacing is cramped (padding: 1–5px), the CTA is
illegible (white-on-white), the footer is invisible (#222 on black).

## What "done" means

The reviewer (with screenshots) cannot identify any further
`improvement`-tier visual issues across the manifest's visual
dimensions. Tests do not apply to this target — the audit is purely
visual.

## Constraints

- HTML structure may be edited (text content, class names, semantic
  tags) but **the actual content must remain** — don't delete sections
  or change headlines/copy beyond what's needed for hierarchy fixes.
- `style.css` is the main surface to fix. You may rewrite it entirely.
- No JavaScript additions, no external font/CDN dependencies (offline-
  renderable; the file:// URL must continue to work without network).
- No new dependencies of any kind.

## Hint to the profiler

This is a UI / visual project. The orchestrator will render the page
to PNG screenshots before each reviewer call. Manifest dimensions
should include several visual axes (visual hierarchy, spacing rhythm,
typography, color palette, interaction affordance, responsive polish)
that the reviewer audits via screenshots, not just by reading CSS.
