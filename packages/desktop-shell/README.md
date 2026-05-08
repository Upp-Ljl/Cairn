# desktop-shell

Cairn project control surface — Electron desktop app. Reads
`~/.cairn/cairn.db` directly in the main process (no separate state
server needed). Runs as **panel + pet + tray**: a side panel for project
state at a glance, the pixel pet for ambient presence, and a system
tray icon with a 3-state status (idle / warn / alert).

Strictly **read-only** by default — all mutations stay on the agent /
CLI / MCP path. See `PRODUCT.md` §12 D9 for the upgrade prerequisites.

## Setup

```bash
cd packages/desktop-shell
npm install
```

If `better-sqlite3` fails to load at runtime due to Electron's Node ABI
mismatch, rebuild it:

```bash
npx electron-rebuild -f -w better-sqlite3
```

> Note: `package.json` has a `postinstall` script that pins
> `--target 32.3.3` for prebuild-install. If you upgrade Electron, that
> target string has to be bumped to match — otherwise the prebuild
> won't be picked up and you'll fall back to a build-from-source that
> needs MSVC. Plan risk **R15**.

## Run

```bash
npm start
```

What you get:

- **Side panel** (`panel.html`, ~480×600). Default tab = **Run Log**;
  second tab = Tasks. Top of the panel: workspace label, DB path, `⋯`
  menu (Switch DB / workspace, Open Legacy Inspector). 6-line project
  summary card refreshes every 1s.
- **Pet** (`preview.html`, bottom-right of the primary screen). Click
  the pet to open the legacy Inspector window (kept for compatibility
  with `dogfood-live-pet-demo.mjs` and as a fallback view).
- **Tray icon** (Windows system tray / macOS menu bar). Three states:
  - 🔴 **alert** — open conflicts > 0 OR failed outcomes > 0
  - 🟡 **warn** — open blockers > 0 OR WAITING_REVIEW tasks > 0
  - ⚫ **idle** — none of the above
  - Tooltip: `Cairn — N agents · N blockers · N FAIL · N conflicts`
  - **Click**: toggle panel show/hide.
  - **Right-click**: `Open Cairn` / `Open Legacy Inspector` / `Quit`.
- **Panel close ≠ app quit.** The OS close button hides the panel; the
  tray stays alive. Use the tray's **Quit** menu to exit.

### Legacy Inspector fallback

```bash
npm start -- --legacy
```

Or pick `Open Legacy Inspector` from the tray menu. The legacy
Inspector (4 sections: agents / conflicts / dispatches / lanes) is
preserved unchanged from pre-Quick-Slice, but its mutation buttons
(Resolve) are hidden whenever desktop mutations are disabled (see
below).

## Read-only default + dev mutation flag

The panel itself never renders any mutation UI. The legacy Inspector's
`Resolve` button is also hidden by default. To re-enable
**only** the legacy resolve-conflict path (kept for backward compat
with `dogfood-live-pet-demo.mjs`):

```bash
# Windows / bash
CAIRN_DESKTOP_ENABLE_MUTATIONS=1 npm start
```

When enabled:
- Main process registers the `resolve-conflict` IPC handler.
- Preload exposes `window.cairn.resolveConflict`.
- Legacy Inspector renders the Resolve button.
- Console prints a one-line dev-only warning at boot.

The new panel `panel.html` renders zero mutation buttons even with the
flag on — by design.

## Live dogfood

```bash
# Insert demo fixtures (idempotent: re-running re-cleans first)
node scripts/mvp-quick-slice-dogfood.mjs --setup

# Inspect what's in the DB right now
node scripts/mvp-quick-slice-dogfood.mjs --status

# Remove all cairn-demo-* rows
node scripts/mvp-quick-slice-dogfood.mjs --cleanup
```

Fixture rows cover: 2 ACTIVE agents, 3 tasks (BLOCKED / FAILED /
RUNNING), 1 OPEN blocker with question, 1 FAIL outcome with summary, 1
OPEN conflict on `shared/types.ts`, 1 PENDING dispatch. Every id is
prefixed `cairn-demo-` so cleanup is a single LIKE filter and never
touches real data.

After `--setup`, launch `npm start` and walk the verification
checklist in
[`docs/superpowers/demos/MVP-quick-slice-desktop-dogfood.md`](../../docs/superpowers/demos/MVP-quick-slice-desktop-dogfood.md).

There's also an older 30-second pet-only demo:

```bash
node dogfood-live-pet-demo.mjs   # review → resolve → failed → jumping; auto-cleans
```

This one predates the Quick Slice and is kept for the legacy Inspector
+ pet sprite path.

## Browser preview fallback (debug)

The original browser preview still works for development without
Electron:

```bash
node state-server.js   # starts HTTP server on localhost:7842
```

Then open `preview.html` in a browser. The debug UI (status line, JSON
panel, bg toggle, manual dropdown) is visible in browser mode but
hidden when running under Electron.

## File map

| File | Role |
|---|---|
| `main.cjs` | Electron lifecycle, window mgmt, IPC, tray, SQLite handle. |
| `preload.cjs` | `window.cairn` bridge. Mutation channel only exposed under the dev flag. |
| `queries.cjs` | All read-only SQL + 5 JSDoc typedefs (TaskRow / BlockerRow / OutcomeRow / ConflictRow / DispatchRequestRow). |
| `panel.html` / `panel.js` | Quick Slice side panel. Default Run Log tab + Tasks tab + inline expansion. |
| `inspector-legacy.html` / `inspector-legacy.js` | Legacy 4-section Inspector. Resolve button hidden unless mutations are enabled. |
| `preview.html` / `preview.js` | Pet sprite renderer (schema → animation contract; PRODUCT.md §8.5). |
| `state-server.js` | HTTP browser fallback (debug only). |
| `scripts/mvp-quick-slice-dogfood.mjs` | Fixture setup / status / cleanup. |
| `SCHEMA_NOTES.md` | Live DB schema reference for the 6 host-level tables. |
