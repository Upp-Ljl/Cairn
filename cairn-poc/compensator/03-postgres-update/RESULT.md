# POC 03 — SQL UPDATE (P4)

Environment: sqlite via `better-sqlite3` (docker Postgres unavailable on host). Same UPDATE/SELECT semantics.

## Result: PASS (single-PK case)

- `recordMs` = 10ms (in-proc sqlite — under a real Postgres this would be network + query plan time, typically 1-5 ms on LAN).

## Architecture

1. proxy expects a structured `{set, where}` shape — it does **not** parse free-form SQL. Freeform parsing is a rabbit hole (subqueries, CTE, RETURNING, triggers).
2. record does `SELECT * FROM t WHERE <where>` using the **same** WHERE clause as the UPDATE.
3. compensator plans **one UPDATE per row keyed by PK** (id), regardless of the forward WHERE. This is correct because id is stable; if the forward update changed the column used in the WHERE, rerunning the original WHERE would match 0 rows.

## Field coverage gap

- Proxy assumes table has a single-column PK named `id`. Composite or non-`id` PKs require schema introspection.
- No handling of database-side triggers or side effects (audit tables, FK cascades). The UPDATE trigger may fire twice (forward + revert) — not idempotent from DB's perspective.
- `RETURNING` clauses not supported.
- Time-of-check-to-time-of-use: between our SELECT and UPDATE a concurrent writer can change the row. Production needs `SELECT … FOR UPDATE` in one transaction with the UPDATE, or optimistic concurrency via `WHERE updated_at=?`.

## Scale

A WHERE that matches 10k rows means a before-image of 10k rows in the lane file. For UPDATEs touching many rows we need either (a) chunked before-images stored in object storage or (b) a rule that reversible = at most N rows.
