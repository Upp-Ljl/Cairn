#!/usr/bin/env node
// Vanilla a11y static checker for src/page.html.
// Pure regex scanning, zero dependencies. Run: `node tests/check_a11y.mjs`
// from the target dir. Exits 0 iff every rule passes.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '..', 'src', 'page.html');

if (!existsSync(htmlPath)) {
  console.error(`FAIL: ${htmlPath} does not exist`);
  process.exit(2);
}

const html = readFileSync(htmlPath, 'utf8');
const failures = [];

const fail = (rule, msg) => failures.push(`[${rule}] ${msg}`);

// Helpers — naive but predictable.
const findTags = (tag) => {
  // Match opening tags including self-closing variants. Captures the full
  // attribute string between `<tag` and the closing `>` (non-greedy).
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
  return [...html.matchAll(re)].map(m => ({ full: m[0], attrs: m[1] || '' }));
};
const hasAttr = (attrs, name) =>
  new RegExp(`\\b${name}\\s*=\\s*['"][^'"]*['"]`, 'i').test(attrs);
const getAttr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]*)['"]`, 'i'));
  return m ? m[1] : null;
};
const innerText = (tag, attrs) => {
  // Pull element body for tags that have closing tag.
  // Build the regex from the original opening string so e.g. <button> matches.
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const m = re.exec(html);
  return m ? m[1] : null;
};

// ---------- 1. <html lang="..."> ----------
const htmlTags = findTags('html');
if (htmlTags.length === 0) {
  fail('html-lang', '<html> tag not found');
} else if (!hasAttr(htmlTags[0].attrs, 'lang') || getAttr(htmlTags[0].attrs, 'lang') === '') {
  fail('html-lang', '<html> must declare a non-empty lang attribute');
}

// ---------- 2. <title> ----------
const titleMatches = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
if (titleMatches.length !== 1) {
  fail('title', `expected exactly one <title>, found ${titleMatches.length}`);
} else if (titleMatches[0][1].trim() === '') {
  fail('title', '<title> must not be empty');
}

// ---------- 3. <img alt="..."> ----------
for (const img of findTags('img')) {
  if (!hasAttr(img.attrs, 'alt')) {
    fail('img-alt', `<img> missing alt attribute: ${img.full}`);
  }
}

// ---------- 4. <button> labelling ----------
const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
for (const m of html.matchAll(buttonRegex)) {
  const attrs = m[1];
  const text = m[2].replace(/<[^>]+>/g, '').trim();
  const labelled = hasAttr(attrs, 'aria-label') || hasAttr(attrs, 'aria-labelledby');
  if (!text && !labelled) {
    fail('button-label', `empty <button> without aria-label/aria-labelledby: ${m[0].slice(0, 80)}`);
  }
}

// ---------- 5. <input> labelling ----------
const inputs = findTags('input');
const labelFors = [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*['"]([^'"]+)['"]/gi)].map(m => m[1]);
for (const inp of inputs) {
  // Skip implicit-label-friendly types that don't strictly need labels.
  const type = (getAttr(inp.attrs, 'type') || 'text').toLowerCase();
  if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;

  const id = getAttr(inp.attrs, 'id');
  const ariaLabelled =
    hasAttr(inp.attrs, 'aria-label') || hasAttr(inp.attrs, 'aria-labelledby');
  const hasLabelFor = id && labelFors.includes(id);
  if (!ariaLabelled && !hasLabelFor) {
    fail('input-label', `<input> not labelled (need id+<label for=> OR aria-label): ${inp.full}`);
  }
}

// ---------- 6. clickable non-button non-link must be keyboard-reachable ----------
for (const tag of ['div', 'span', 'p']) {
  const re = new RegExp(`<${tag}\\b([^>]*\\bonclick\\b[^>]*)>`, 'gi');
  for (const m of html.matchAll(re)) {
    const attrs = m[1];
    const role = getAttr(attrs, 'role');
    const tabindex = getAttr(attrs, 'tabindex');
    const hasKeyHandler =
      hasAttr(attrs, 'onkeydown') || hasAttr(attrs, 'onkeyup') || hasAttr(attrs, 'onkeypress');
    if (role !== 'button') {
      fail('click-keyboard', `<${tag} onclick=...> needs role="button" — found role=${JSON.stringify(role)} in ${m[0].slice(0, 80)}`);
    }
    if (tabindex === null || tabindex === '') {
      fail('click-keyboard', `<${tag} onclick=...> needs tabindex (e.g. "0") in ${m[0].slice(0, 80)}`);
    }
    if (!hasKeyHandler) {
      fail('click-keyboard', `<${tag} onclick=...> needs onkeydown/onkeyup/onkeypress in ${m[0].slice(0, 80)}`);
    }
  }
}

// ---------- Output ----------
if (failures.length > 0) {
  console.error(`A11Y CHECK FAILED — ${failures.length} violation(s):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('A11Y CHECK PASSED — all rules satisfied');
