# Cairn v0.1 — Release Decision Checklist

> Status: **engineering + product docs complete; release decisions pending owner sign-off.**
> Created: 2026-05-28 (after Phase 4 push of `9ed613b..8eef94a`).
> Scope: this file is a decision worksheet, not a design doc. Each item lists options + tradeoffs. Owner picks one per item; this file gets updated in place as decisions land.

---

## State at the time this checklist was opened

- main = `8eef94a`, pushed to `origin/main` (Upp-Ljl/Cairn) — verified by ls-remote.
- 28 MCP tools, 10 migrations, 411 daemon tests + 329 mcp-server tests + 1 pre-existing skip, 32/32 W5 Phase 3 dogfood PASS.
- Core docs unified: `README.md` / `PRODUCT.md` / `ARCHITECTURE.md` / `CLAUDE.md` / `RELEASE_NOTES.md` / `docs/superpowers/demos/README.md`.
- Working tree dirty (held per Phase 4 protocol): `packages/desktop-shell/spritesheet.webp` (M) + `spritesheet.v0.webp` (??).
- No new features pending — explicit "don't add features" hold per owner directive.

---

## 1. License selection

**Why this is decision #1:** every other release decision (npm publish, public tag, external users) depends on the license being declared.

| Option | Pro | Con | Best for |
|---|---|---|---|
| **MIT** | maximum permissiveness, near-universal acceptance, simplest text | no patent grant, no defensive provisions | maximum adoption / no commercial differentiation plan |
| **Apache-2.0** | explicit patent grant, modification-marker requirement, well-understood by enterprise legal | longer text, marginally more compliance overhead for downstream | wider corporate use / future patent landscape |
| **Source-available (e.g., BSL 1.1, PolyForm)** | controls commercial redistribution while allowing inspection + dogfood | not OSI-approved → some users will not adopt | preserve future commercial optionality |
| **No LICENSE for now** | preserves all options | blocks #2 / #3 / #4 in this checklist | only if owner is genuinely undecided |

**Owner action:** pick one; I write `LICENSE` file at repo root in the standard SPDX-recognized text + update `README.md` License section + `package.json` `"license"` fields in both `packages/daemon` and `packages/mcp-server`.

**Decision:** **Apache-2.0** (2026-05-28). Rationale: Cairn is host-level infrastructure intended to be embedded by AI coding agents and their host tools; the explicit patent grant is the relevant differentiator over MIT for that future. Files landed in working tree (not yet committed): `LICENSE` (Apache-2.0 standard text + `Copyright 2026 The Cairn Contributors`), `README.md` License section updated, `packages/daemon/package.json` and `packages/mcp-server/package.json` both with `"license": "Apache-2.0"`.

---

## 2. Package distribution strategy

| Option | Pro | Con |
|---|---|---|
| **npm publish now** (both `@cairn/daemon` and `@cairn/mcp-server`, public) | enables `npx cairn install`; aligns with `cairn install` CLI's stated future path | locks in package names + versioning cadence; needs LICENSE first |
| **GitHub only, install via file-link or git URL** | zero npm coupling; current `cairn install` instructions already document file-link path | friction for new users; `npx cairn install` story stays aspirational |
| **Private npm scope first (e.g., `@upp-ljl/...`), promote to public later** | gates first wave of users without blocking package mechanics | extra step at promotion time; not really "private dogfood" if the GitHub repo is public |
| **GitHub Releases attaching prebuilt tarballs** | discoverable; doesn't require npm; works with `npm install <url>` | manual release process unless CI added |

**Constraint:** `cairn install` CLI in `packages/mcp-server/dist/cli/install.js` currently writes absolute paths into `.mcp.json` and `start-cairn-pet.{bat,sh}`; under npm publish path it would need to detect installed location (likely `require.resolve('@cairn/mcp-server')` style). That's a small follow-up if/when npm path is chosen.

**Decision:** **GitHub-only for v0.1** (2026-05-28). Rationale: `cairn install` CLI's absolute-path strategy is incompatible with npm-global install today; flipping to npm publish requires a small follow-up (`require.resolve` style) and we don't want to gate v0.1 release on it. Both `package.json` files keep `"private": true` until a future release flips the strategy. v0.2 may revisit.

---

## 3. Tag `v0.1.0` timing

| Option | Pro | Con |
|---|---|---|
| **Tag now (HEAD = `8eef94a`)** | clean snapshot of "engineering + docs complete" state | feels premature without LICENSE; can't easily withdraw a public tag |
| **Tag after LICENSE lands** | tagged commit is unambiguously open-source-or-not | one extra commit between docs-complete and tag |
| **Wait for first external user feedback to integrate, then tag** | tag represents what others actually used | indefinite delay; checkpoint-y |
| **Don't tag — use commit SHAs** | maximum flexibility | external users have nothing to install / cite |

**Recommendation given the listed sequence:** owner already said in the directive that tagging without LICENSE feels uncomfortable, so the natural ordering is decide #1 → land LICENSE commit → then `git tag -a v0.1.0` on the LICENSE commit (or `8eef94a` if owner prefers tag-then-license, accepting the awkwardness).

**Decision:** **Tag `v0.1.0` after the LICENSE commit lands** (2026-05-28). The tag will point at the LICENSE commit (currently uncommitted; commit + tag will be a single small batch once owner confirms the LICENSE draft). Tag push requires the separate `--tags` push command (see protocol below); main push and tag push are two separate operations.

**Tag push protocol (when decision lands):** tags do NOT follow `git push origin main` — push separately:

```bash
TOKEN=$(cat .cairn-push-token/ljl-token.txt | tr -d '[:space:]')
git push "https://x-access-token:${TOKEN}@github.com/Upp-Ljl/Cairn.git" --tags
```

(Per `CLAUDE.md` §推送; redact token in any captured output.)

---

## 4. External dogfood — first wave

| Option | Pro | Con | Approximate friction for first user |
|---|---|---|---|
| **Solo open dogfood — public GitHub README** | no gatekeeping; aligns with eventual open posture | uncontrolled feedback shape; any onboarding friction is on the user | high (file-link install, no npm, no LICENSE → some users will bail) |
| **Invite list (≤ 5 trusted multi-agent users)** | controllable feedback; can iterate install instructions before broad release | gating effort; depends on owner's network | medium |
| **Single "design partner" first** | deepest iteration loop; one user shapes the experience | sample of one; risks over-fitting | low (owner can hand-hold) |

**Prereq for any external user**: LICENSE decision (#1) and probably tag (#3) so they have something to clone at a known good point.

**Suggested invite criteria** (if option 2 or 3): user runs ≥ 2 agent tools at the same time today (per PRODUCT.md §3.1 target user); willing to file structured feedback against a known-issues template; has Node 24 + Git on their machine.

**Decision:** **Invite list ≤ 5 trusted multi-agent users for first dogfood; do not publicize broadly until feedback loops** (2026-05-28). Rationale: keeps onboarding-friction iteration tight; matches the "engineering complete, release decisions pending" framing — broad publicity before LICENSE + tag are visible would amplify the wrong signal.

**Pending owner action:** the 5-name invite list itself is not maintained in this file — owner picks names through their own channel; this decision only locks the strategy.

---

## 5. Spritesheet working-tree files

The two files held outside Phase 4: `packages/desktop-shell/spritesheet.webp` (M) and `spritesheet.v0.webp` (??).

| Option | What happens | When to choose |
|---|---|---|
| **Discard via `git checkout -- spritesheet.webp` + `rm spritesheet.v0.webp`** | working tree clean; what's on disk goes back to the committed version | the changes are stale / abandoned and the v0 file is detritus |
| **Keep as working-tree drift indefinitely** | status of the repo always shows 2 dirty files | we accept the noise; useful only if there's an active design task on these |
| **Standalone `chore(desktop-shell)` commit explaining what changed** | history captures the change; tree clean afterward | the change is intentional and we want to land it before any v0.1.0 tag |

**Owner needs to recall:** what was the spritesheet edit / addition for? Until that context is back, "keep" or "discard" cannot be picked safely.

**Decision:** **Keep — leave both files untouched in working tree until provenance is recalled** (2026-05-28). Rationale: discarding without knowing what the changes are is an irreversible information loss (especially `spritesheet.v0.webp`, which is untracked and would be deleted not reverted); keeping costs only the noise of two `git status` lines. Re-evaluate when desktop-shell work resumes or owner recalls context.

---

## Decision sequencing (recommended)

```
1. License (#1)
   ↓
2. Spritesheet (#5) — independent, but should be cleared before tag
   ↓
3. Tag v0.1.0 (#3) — lands on the LICENSE commit (or LICENSE + spritesheet commit)
   ↓
4. Package strategy (#2) — can wait until first npm-publish demand surfaces
   ↓
5. External dogfood (#4) — once #1 + #3 are landed, open the invite list
```

The only hard ordering constraint is **#1 before #3**. The rest can be reordered or done in parallel.

---

## 6. A2 Mentor UI — §12 D9 controlled deviation

**Context:** PRODUCT.md §12 D9 states that the panel is read-only by default and mutation buttons render only in the legacy Inspector when `CAIRN_DESKTOP_ENABLE_MUTATIONS=1`. Mentor's chat input (askMentor IPC) is a write-path call — it spawns a provider LLM run — so it technically deviates from the strict §12 D9 read-only default.

**Decision:** **Path A — panel Mentor section, gated identically to Day 5 candidate actions** (2026-05-11). Rationale: B2 §1.1 explicitly recommends "new sub-section, not Inspector reuse" because Inspector's affordance is state inspection (passive) while Mentor's is conversational advisory (active input field + multi-turn). Placing Mentor in the Inspector would violate the B2 spec's UI separation rationale. The gate (`CAIRN_DESKTOP_ENABLE_MUTATIONS=1`) is the same dev-flag pattern used for `resolveConflict` / `acceptCandidate` / `runContinuousIteration`; in mutations=off (the default install), the entire `#mentor-pane` is hidden and `window.cairn.askMentor` is undefined, so no accidental write-path call is possible. Defense in depth: JS also guards on `typeof window.cairn.askMentor === 'function'` before rendering the pane.

**Files changed (A2 commit):** `packages/desktop-shell/panel.html` (CSS + HTML) · `packages/desktop-shell/panel.js` (mentor functions + poll hook).

---

## How this file evolves

When a decision is made, update the corresponding **Decision: _[pending]_** line in place with the chosen option + a one-line rationale + date. When all 5 are decided, this file can either stay as a record or be archived under `docs/` — owner's call.
