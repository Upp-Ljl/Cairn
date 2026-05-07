# desktop-shell

Cairn floating pet — Electron desktop app. Reads `~/.cairn/cairn.db` directly in the main process (no separate state server needed).

## Setup

```bash
cd packages/desktop-shell
npm install
```

If `better-sqlite3` fails to load at runtime due to Electron's Node ABI mismatch, rebuild it:

```bash
npx electron-rebuild -f -w better-sqlite3
```

## Run (Electron)

```bash
npm start
```

The pet appears bottom-right of the primary screen. Click the pet to open the Inspector panel. The Inspector polls every 1s and shows active agents, open conflicts, recent dispatches, and active lanes.

## Live demo against real DB

```bash
node dogfood-live-pet-demo.mjs     # 30s scripted: review → resolve → failed → jumping; auto-cleans `cairn-demo-` rows
```

## Browser preview fallback (debug)

The original browser preview still works for development without Electron:

```bash
node state-server.js   # starts HTTP server on localhost:7842
```

Then open `preview.html` in a browser. The debug UI (status line, JSON panel, bg toggle, manual dropdown) is visible in browser mode but hidden when running under Electron.
