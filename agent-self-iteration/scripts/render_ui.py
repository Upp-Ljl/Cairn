#!/usr/bin/env python3
"""Render a URL or local HTML file to one or more PNG screenshots.

Used by dual_agent_iter.sh's UI-audit mode (UI_RENDER=1) so the reviewer
can perform a multimodal visual audit, not just code-level review.

Usage:
    render_ui.py --url URL --out DIR [--viewports W1xH1,W2xH2,...] [--wait MS]
    render_ui.py --file PATH --out DIR [...]

Exit codes:
    0  — at least one screenshot written successfully
    2  — Playwright not installed (caller should treat as "skip UI audit")
    3  — render failed for all viewports (caller may continue without shots)

We deliberately fail SOFT: a missing browser dependency or a bad URL
should not crash the auto-iter loop. The driver checks the exit code
and continues without screenshots if anything goes wrong, so the loop's
text-only audit path always works as a fallback.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse


def _resolve_target(url: str | None, file: str | None) -> str:
    if url:
        return url
    if file:
        path = Path(file).resolve()
        if not path.exists():
            print(f"[render_ui] target file not found: {path}", file=sys.stderr)
            sys.exit(3)
        return path.as_uri()
    print("[render_ui] need --url or --file", file=sys.stderr)
    sys.exit(2)


def _parse_viewports(spec: str) -> list[tuple[str, int, int]]:
    """Parse "1280x720,375x667" → [("desktop_1280x720", 1280, 720), ...].

    The label is derived from the dimensions; "desktop_" / "mobile_" /
    "tablet_" prefixes are added based on width.
    """
    out: list[tuple[str, int, int]] = []
    for entry in spec.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            w, h = entry.lower().split("x")
            w_i, h_i = int(w), int(h)
        except ValueError:
            print(f"[render_ui] bad viewport '{entry}', expected WxH", file=sys.stderr)
            continue
        if w_i < 480:
            label = f"mobile_{w_i}x{h_i}"
        elif w_i < 1024:
            label = f"tablet_{w_i}x{h_i}"
        else:
            label = f"desktop_{w_i}x{h_i}"
        out.append((label, w_i, h_i))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="URL to render (http://, https://, file://)")
    ap.add_argument("--file", help="local file path; converted to file:// URI")
    ap.add_argument("--out", required=True, help="output directory for PNGs")
    ap.add_argument(
        "--viewports",
        default="1280x800,375x812",
        help='comma-separated list of WxH (default: "1280x800,375x812" — desktop + iPhone-like)',
    )
    ap.add_argument(
        "--wait",
        type=int,
        default=600,
        help="ms to wait after page load before screenshot (default 600)",
    )
    ap.add_argument(
        "--full-page",
        action="store_true",
        help="capture full scrolling page (default: viewport only)",
    )
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright  # type: ignore[import-not-found]
    except ImportError:
        print(
            "[render_ui] playwright not installed; UI audit will be skipped.\n"
            "  install:  pip install playwright && playwright install chromium",
            file=sys.stderr,
        )
        return 2

    target = _resolve_target(args.url, args.file)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    viewports = _parse_viewports(args.viewports)
    if not viewports:
        print("[render_ui] no valid viewports", file=sys.stderr)
        return 3

    written: list[str] = []
    errors: list[str] = []

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=True)
            except Exception as e:
                print(
                    f"[render_ui] chromium launch failed: {e}\n"
                    "  install:  playwright install chromium",
                    file=sys.stderr,
                )
                return 2

            for label, w, h in viewports:
                shot_path = out_dir / f"{label}.png"
                try:
                    ctx = browser.new_context(viewport={"width": w, "height": h})
                    page = ctx.new_page()
                    page.goto(target, wait_until="networkidle", timeout=15_000)
                    if args.wait > 0:
                        page.wait_for_timeout(args.wait)
                    page.screenshot(path=str(shot_path), full_page=args.full_page)
                    ctx.close()
                    written.append(str(shot_path))
                    print(f"[render_ui] wrote {shot_path}", file=sys.stderr)
                except Exception as e:
                    errors.append(f"{label}: {e}")
                    print(f"[render_ui] {label} failed: {e}", file=sys.stderr)
            browser.close()
    except Exception as e:  # outermost net — never let playwright errors kill us
        print(f"[render_ui] unexpected playwright error: {e}", file=sys.stderr)
        return 3

    # Manifest of what was rendered, for the reviewer's reference.
    manifest = {
        "target": target,
        "out_dir": str(out_dir),
        "screenshots": [
            {"label": Path(p).stem, "path": p, "viewport_label": Path(p).stem}
            for p in written
        ],
        "errors": errors,
        "rendered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    return 0 if written else 3


if __name__ == "__main__":
    sys.exit(main())
