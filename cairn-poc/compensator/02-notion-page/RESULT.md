# POC 02 — Notion page PATCH (P4)

## Result: PASS for common properties

- `archived`, `icon`, and properties of types `title / select / multi_select / number` all revert cleanly.
- `recordMs` = 30ms single run.

## Field coverage gap (KEY FINDING)

Tested property types that are PATCHable in real Notion but that our simple GET→PATCH symmetry does NOT cover:

| Type | GET visible? | PATCH accepts? | Revertable via before-image alone? |
|------|--------------|----------------|------------------------------------|
| title, rich_text, number, select, multi_select, date, checkbox, url, email, phone | yes | yes | YES |
| status | yes | yes | yes (same shape as select) |
| people | yes, as [{id,...}] | yes, as [{id}] | yes if we strip extra fields |
| files | yes with `file.url` (expiring!) | yes with external.url OR uploaded file ref | **NO — uploaded file URL is signed and expires; before-image URL is useless after TTL** |
| relation | yes with page refs | yes | yes |
| rollup, formula, created_time, last_edited_time, last_edited_by, created_by, unique_id | yes | **no (read-only)** | n/a — but proxy must filter to avoid 400 |
| **verification** (Enterprise) | yes with `verified_by` | yes only via special endpoint | no |

The proxy explicitly collects `coverageGaps` for props it cannot restore (read-only types and unknown props). In this run gaps=0 because the forward patch only touched covered types.

## Architecture note

Notion PATCH merges per-property — it is a partial PATCH, not a full replace. The compensator body mirrors the forward body's touched property keys only. **Not** "restore the whole page" because that would require listing every property (some may belong to other integrations).

## Race

No updated_at / ETag support in the real API — lost-update race is unavoidable without polling.
