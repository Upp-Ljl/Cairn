# DUCKPLAN — Phase 4 Slice A: Windows packaging

> Plan filename: `2026-05-11-phase4-packaging-windows.md`
> Plan author: lead agent (this session)
> Date: 2026-05-11
> Workflow: per `docs/workflow/HOWTO-PLAN-PR.md`

## 1. Plan

Add `electron-builder` configuration to `packages/desktop-shell/package.json` so that `npm run dist:win` produces a Windows NSIS installer (`.exe`). The installer must:
- Bundle the desktop-shell + native better-sqlite3 binding compiled for Electron 32
- Install to `%LOCALAPPDATA%\Cairn`
- Launch the panel on first run

Scope of this slice (slice A of Phase 4):
- Windows NSIS target only
- No code-signing (Later)
- No auto-update (Later)
- Mac `.dmg` config written but not built from this machine (slice B; needs Mac/CI)
- `cairn install` CLI hardening is slice C (separate plan)

## 2. Expected Outputs

After this slice lands:

- `packages/desktop-shell/package.json` has a `build` field with `appId: "ai.renlab.cairn"`, `productName: "Cairn"`, `nsis` config, `win.target: "nsis"`, files glob, native rebuild config
- `packages/desktop-shell/package.json` has `"scripts": { ..., "dist:win": "electron-builder --win nsis" }`
- `packages/desktop-shell/build/icon.ico` (256×256 placeholder; can swap real icon later)
- `packages/desktop-shell/dist/Cairn Setup 0.0.1.exe` produced after `npm run dist:win`
- `packages/desktop-shell/scripts/smoke-electron-builder-config.mjs` validates the config statically (4+ assertions)
- Commit on branch `packaging/win-nsis-mvp`

## 3. How To Verify

```bash
# Step A — static config validation
node packages/desktop-shell/scripts/smoke-electron-builder-config.mjs
# expect: ≥ 4/4 assertions pass

# Step B — actually build (slow, network-dependent for electron download)
cd packages/desktop-shell && npm run dist:win
# expect: exit 0; dist/Cairn Setup 0.0.1.exe exists; size > 50 MB and < 200 MB
ls -la packages/desktop-shell/dist/
# expect: see "Cairn Setup 0.0.1.exe"

# Step C — installer runs (manual; not part of automated verify since requires GUI)
# "Cairn Setup 0.0.1.exe" /S  (silent install)
# Then check: %LOCALAPPDATA%\Cairn\Cairn.exe exists and launches without crash
# NOTE: this step gated; smoke does not run it.
```

## 4. Probes

Cross-engine JSON probe of the electron-builder config:

```bash
# Gate 1 — claude haiku
PROMPT='Read packages/desktop-shell/package.json. Extract just the "build" field. Output canonical JSON with keys sorted: {appId, productName, targets: [{platform, target}], files_glob_count}. JSON only.'
claude --model haiku -p "$PROMPT" > /tmp/gate1.json
jq -S . /tmp/gate1.json > /tmp/gate1.canonical.json

# Gate 2 — Agent subagent general-purpose
# Dispatch Agent(general-purpose, prompt=$PROMPT)
# Save to /tmp/gate2.json then canonicalize

# Hard match
diff -u /tmp/gate1.canonical.json /tmp/gate2.canonical.json
# expect: zero output
```

## 5. Out Of Scope

- Mac `.dmg` build (config only, no actual `npm run dist:mac` from this machine)
- Code-signing on either platform
- Auto-update mechanism
- npm publish of `@cairn/mcp-server` (slice D, requires user approval)
- Tag `v0.1.0` (requires user approval)
- Real app icon (placeholder OK for this slice; designer asset is Later)
