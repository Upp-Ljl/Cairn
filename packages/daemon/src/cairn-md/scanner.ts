/**
 * CAIRN.md scanner — canonical TypeScript port (Phase 2, 2026-05-14).
 *
 * Source: `packages/desktop-shell/mentor-project-profile.cjs`, schema v2.
 * Phase 2 hoists the parser into the daemon so both desktop-shell (.cjs)
 * AND mcp-server (.ts) can consume it from `daemon/dist/cairn-md/`.
 *
 * Side effects: NONE in pure parse functions. The cache layer
 * (`loadProfile`) writes to the scratchpad table — kernel state, same as
 * any other repository.
 *
 * Schema v2 vs v1 (per docs/CAIRN-md-spec.md):
 *   - ADD  `whole_sentence` — single-sentence project complete-form
 *   - KEEP `goal` — reframed as "current sub-Whole milestone"
 *   - DROP `current_phase` — time-anchored fields removed
 *
 * Two callers ride this module:
 *   1. desktop-shell `.cjs` bridge — old API preserved (synonym-compat
 *      shape via the .cjs delegate; identical match semantics).
 *   2. mcp-server `task.block` synchronous auto-resolve path (Phase 2).
 *
 * Backward semantics: `matchKnownAnswer` is byte-for-byte equivalent to
 * the prior `.cjs` implementation — substring match, first-match-wins,
 * lowercase on both sides.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import { putScratch } from '../storage/repositories/scratchpad.js';

export const PROFILE_VERSION = 2;

export interface ProfileAuthority {
  auto_decide: string[];
  decide_and_announce: string[];
  escalate: string[];
}

export interface KnownAnswer {
  pattern: string;
  answer: string;
}

export interface Profile {
  version: number;
  source_path: string | null;
  exists: boolean;
  source_mtime_ms: number | null;
  source_sha1: string | null;
  scanned_at: number;
  project_name: string | null;
  whole_sentence: string | null;
  goal: string | null;
  is_list: string[];
  is_not_list: string[];
  authority: ProfileAuthority;
  constraints: string[];
  known_answers: KnownAnswer[];
  raw_sections: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Empty / default profile
// ---------------------------------------------------------------------------

export function emptyProfile(absPath: string | null): Profile {
  return {
    version: PROFILE_VERSION,
    source_path: absPath,
    exists: false,
    source_mtime_ms: null,
    source_sha1: null,
    scanned_at: Date.now(),
    project_name: null,
    whole_sentence: null,
    goal: null,
    is_list: [],
    is_not_list: [],
    authority: { auto_decide: [], decide_and_announce: [], escalate: [] },
    constraints: [],
    known_answers: [],
    raw_sections: {},
  };
}

// ---------------------------------------------------------------------------
// Markdown section parser — naive on purpose
// ---------------------------------------------------------------------------

export function normalizeSectionKey(headerText: string): string {
  return String(headerText || '')
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[:,;.]+\s*$/, '')
    .trim();
}

export function splitSections(text: string): Record<string, string> {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out: Record<string, string[]> = { _preamble: [] };
  let current = '_preamble';
  for (const raw of lines) {
    const h2 = raw.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = normalizeSectionKey(h2[1]!);
      if (!out[current]) out[current] = [];
      continue;
    }
    if (!out[current]) out[current] = [];
    out[current]!.push(raw);
  }
  const joined: Record<string, string> = {};
  for (const k of Object.keys(out)) {
    joined[k] = (out[k] || []).join('\n').trim();
  }
  return joined;
}

// ---------------------------------------------------------------------------
// Bullet extraction
// ---------------------------------------------------------------------------

export function extractBullets(body: string): string[] {
  const out: string[] = [];
  const lines = String(body || '').split('\n');
  let buf: string | null = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (m) {
      if (buf !== null) out.push(buf.trim());
      buf = m[1]!;
      continue;
    }
    if (buf !== null && /^\s+\S/.test(raw)) {
      buf = buf + ' ' + raw.trim();
      continue;
    }
    if (buf !== null) {
      out.push(buf.trim());
      buf = null;
    }
  }
  if (buf !== null) out.push(buf.trim());
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Authority bullet classification
// ---------------------------------------------------------------------------

export type AuthorityBucket = 'auto_decide' | 'decide_and_announce' | 'escalate';

function stripLeader(s: string, leaders: string[]): string {
  let out = s;
  for (const lead of leaders) {
    if (out.startsWith(lead)) out = out.slice(lead.length).trim();
  }
  out = out.replace(/^mentor\s+auto-?decide[:\- ]*\s*/i, '');
  out = out.replace(/^mentor\s+decide\s*\+\s*announce[:\- ]*\s*/i, '');
  out = out.replace(/^always\s+escalate(\s+to\s+user)?[:\- ]*\s*/i, '');
  return out.trim();
}

function stripPrefix(s: string, re: RegExp): string {
  return String(s || '').replace(re, '').trim();
}

export function classifyAuthorityBullet(line: string): { bucket: AuthorityBucket | null; text: string } {
  const trimmed = String(line || '').trim();
  if (!trimmed) return { bucket: null, text: '' };

  if (trimmed.startsWith('✅')) {
    return { bucket: 'auto_decide', text: stripLeader(trimmed, ['✅']) };
  }
  if (trimmed.startsWith('⚠️') || trimmed.startsWith('⚠')) {
    return { bucket: 'decide_and_announce', text: stripLeader(trimmed, ['⚠️', '⚠']) };
  }
  if (trimmed.startsWith('🛑')) {
    return { bucket: 'escalate', text: stripLeader(trimmed, ['🛑']) };
  }

  const tag = trimmed.toLowerCase();
  if (tag.startsWith('auto:') || tag.startsWith('auto-decide:') || tag.startsWith('auto decide:')) {
    return { bucket: 'auto_decide', text: stripPrefix(trimmed, /^[A-Za-z\- ]*:\s*/) };
  }
  if (tag.startsWith('announce:') || tag.startsWith('decide+announce:') || tag.startsWith('decide + announce:')) {
    return { bucket: 'decide_and_announce', text: stripPrefix(trimmed, /^[A-Za-z+\- ]*:\s*/) };
  }
  if (tag.startsWith('escalate:')) {
    return { bucket: 'escalate', text: stripPrefix(trimmed, /^[A-Za-z\- ]*:\s*/) };
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mentor auto-decide')) {
    return { bucket: 'auto_decide', text: stripPrefix(trimmed, /^mentor auto-decide[: ]*\s*/i) };
  }
  if (lower.startsWith('mentor decide + announce') || lower.startsWith('mentor decide+announce')) {
    return { bucket: 'decide_and_announce', text: stripPrefix(trimmed, /^mentor decide ?\+ ?announce[: ]*\s*/i) };
  }
  if (lower.startsWith('always escalate')) {
    return { bucket: 'escalate', text: stripPrefix(trimmed, /^always escalate( to user)?[: ]*\s*/i) };
  }

  return { bucket: null, text: trimmed };
}

// ---------------------------------------------------------------------------
// IS / IS NOT bullets
// ---------------------------------------------------------------------------

export type IsBucket = 'is' | 'is_not';

export function classifyIsBullet(line: string): { bucket: IsBucket | null; text: string } {
  const trimmed = String(line || '').trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('is not:') || lower.startsWith('isnt:') || lower.startsWith("isn't:")) {
    return { bucket: 'is_not', text: stripPrefix(trimmed, /^(is not|isnt|isn['’]t)[: ]*\s*/i) };
  }
  if (lower.startsWith('is:')) {
    return { bucket: 'is', text: stripPrefix(trimmed, /^is[: ]*\s*/i) };
  }
  return { bucket: null, text: trimmed };
}

// ---------------------------------------------------------------------------
// Known-answers parser
// ---------------------------------------------------------------------------

export function parseKnownAnswers(body: string): KnownAnswer[] {
  const out: KnownAnswer[] = [];
  for (const bullet of extractBullets(body)) {
    const m = bullet.match(/^(.*?)\s*=>\s*(.+)$/);
    if (!m) continue;
    const pattern = m[1]!.trim();
    const answer = m[2]!.trim();
    if (pattern && answer) out.push({ pattern, answer });
  }
  return out;
}

// ---------------------------------------------------------------------------
// H1 / project-name / Goal / Whole extraction
// ---------------------------------------------------------------------------

export function extractProjectName(text: string): string | null {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

export function extractGoal(body: string): string | null {
  if (!body) return null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) continue;
    if (/^[-*+]\s+/.test(line)) {
      return line.replace(/^[-*+]\s+/, '').trim();
    }
    return line;
  }
  return null;
}

export function extractWholeSentence(body: string): string | null {
  if (!body) return null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) continue;
    const cleaned = line.replace(/^[-*+]\s+/, '').trim();
    return cleaned || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section-key lookup (with synonyms)
// ---------------------------------------------------------------------------

type SectionKind = 'whole' | 'goal' | 'is_isnot' | 'authority' | 'constraints' | 'known_answers';

const SECTION_SYNONYMS: Record<SectionKind, string[]> = {
  whole: ['whole', '完整形态', '完整形态 / whole', 'whole (完整形态)', 'complete form', 'north star'],
  goal: ['goal', '目标', 'current goal', 'current milestone', 'current sub-whole milestone'],
  is_isnot: ['what this project is / is not', 'what this project is/is not', 'project is / is not', 'is / is not', 'scope'],
  authority: ['mentor authority (decision delegation)', 'mentor authority', 'authority', 'decision delegation', '权限委托'],
  constraints: ['project constraints', 'constraints', 'project constraints (mentor + agent both follow)', '约束'],
  known_answers: ['known answers', '已知回答'],
};

export function findSectionBody(sections: Record<string, string>, kind: SectionKind): string {
  const candidates = SECTION_SYNONYMS[kind] || [];
  for (const c of candidates) {
    const key = normalizeSectionKey(c);
    if (Object.prototype.hasOwnProperty.call(sections, key) && sections[key]) {
      return sections[key]!;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// scanCairnMd — pure parser (no side effects beyond fs reads)
// ---------------------------------------------------------------------------

export function scanCairnMd(filePath: string | null | undefined): Profile {
  const abs = filePath ? path.resolve(filePath) : null;
  if (!abs) return emptyProfile(null);
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch (_e) { return emptyProfile(abs); }
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch (_e) { return emptyProfile(abs); }

  const profile = emptyProfile(abs);
  profile.exists = true;
  profile.source_mtime_ms = stat.mtimeMs;
  profile.source_sha1 = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
  profile.project_name = extractProjectName(text);

  const sections = splitSections(text);
  profile.raw_sections = sections;

  profile.whole_sentence = extractWholeSentence(findSectionBody(sections, 'whole'));
  profile.goal = extractGoal(findSectionBody(sections, 'goal'));

  for (const bullet of extractBullets(findSectionBody(sections, 'is_isnot'))) {
    const c = classifyIsBullet(bullet);
    if (c.bucket === 'is') profile.is_list.push(c.text);
    else if (c.bucket === 'is_not') profile.is_not_list.push(c.text);
  }

  for (const bullet of extractBullets(findSectionBody(sections, 'authority'))) {
    const c = classifyAuthorityBullet(bullet);
    if (c.bucket && c.text) profile.authority[c.bucket].push(c.text);
  }

  profile.constraints = extractBullets(findSectionBody(sections, 'constraints'));
  profile.known_answers = parseKnownAnswers(findSectionBody(sections, 'known_answers'));

  return profile;
}

// ---------------------------------------------------------------------------
// Match helpers
// ---------------------------------------------------------------------------

const _STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'at', 'by',
  'and', 'or', 'but', 'is', 'are', 'be', 'been', 'have', 'has', 'do',
  'does', 'did', 'i', 'we', 'you', 'it', 'this', 'that', 'with', 'from',
  'should', 'would', 'could', 'when', 'where', 'how', 'why', 'what', 'which',
  'over', 'up', 'as', 'so', 'if', 'then', 'than', 'too', 'about',
]);

function _tokenize(s: string): string[] {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-]+/i)
    .filter(t => t.length >= 3 && !_STOPWORDS.has(t));
}

export function matchBucket(bullets: string[], text: string): string | null {
  if (!Array.isArray(bullets) || !text) return null;
  const corpus = String(text).toLowerCase();
  for (const b of bullets) {
    if (!b) continue;
    if (corpus.includes(b.toLowerCase())) return b;
  }
  const corpusTokens = new Set(_tokenize(corpus));
  if (corpusTokens.size === 0) return null;
  for (const b of bullets) {
    if (!b) continue;
    const bTokens = _tokenize(b);
    if (bTokens.length === 0) continue;
    let hits = 0;
    for (const t of bTokens) {
      if (corpusTokens.has(t)) hits++;
      if (hits >= 2) return b;
    }
  }
  return null;
}

/**
 * Substring match against the profile's known_answers (case-insensitive,
 * first-match-wins). Byte-for-byte semantically equivalent to the
 * desktop-shell `.cjs` implementation (audited 2026-05-14).
 */
export function matchKnownAnswer(profile: Profile | null, question: string): KnownAnswer | null {
  if (!profile || !profile.exists || !Array.isArray(profile.known_answers) || !question) return null;
  const q = String(question).toLowerCase();
  for (const pair of profile.known_answers) {
    if (!pair || !pair.pattern) continue;
    if (q.includes(String(pair.pattern).toLowerCase())) return pair;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache layer — mtime-gated re-scan per git_root, stored in scratchpad
// ---------------------------------------------------------------------------

export function profileCacheKey(gitRoot: string): string {
  const h = crypto.createHash('sha1').update(String(gitRoot)).digest('hex').slice(0, 16);
  return `project_profile_kernel/${h}`;
}

export function resolveCairnMdPath(gitRoot: string | null | undefined): string | null {
  if (!gitRoot || typeof gitRoot !== 'string') return null;
  return path.join(gitRoot, 'CAIRN.md');
}

/**
 * High-level loader for the mcp-server hot path (cairn.task.block auto-
 * resolve). Reads the scratchpad cache, compares to on-disk mtime, and
 * either reuses the cache or re-scans + rewrites the cache.
 *
 * Cache row shape: full Profile JSON.
 *
 * Always returns a valid Profile (exists=false when CAIRN.md absent).
 * Never throws.
 *
 * @param db        better-sqlite3 handle (kernel layer; same handle the
 *                  caller uses for everything else in the same call)
 * @param blobRoot  for putScratch's blob-spill threshold (typically `~/.cairn`)
 * @param gitRoot   project root absolute path (mcp-server already has this
 *                  as `ws.gitRoot`)
 * @param opts.forceRescan  bypass cache (also honoured via CAIRN_KERNEL_PROFILE_NOCACHE env)
 */
export function loadProfile(
  db: DB,
  blobRoot: string,
  gitRoot: string,
  opts?: { forceRescan?: boolean },
): Profile {
  const force = !!(opts && opts.forceRescan) || process.env['CAIRN_KERNEL_PROFILE_NOCACHE'] === '1';
  const cairnPath = resolveCairnMdPath(gitRoot);
  if (!cairnPath) return emptyProfile(null);

  // Inspect on-disk mtime first.
  let onDiskMtime: number | null = null;
  try { onDiskMtime = fs.statSync(cairnPath).mtimeMs; } catch (_e) { onDiskMtime = null; }

  if (!force) {
    // Try cache.
    try {
      const row = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(profileCacheKey(gitRoot)) as
        | { value_json: string }
        | undefined;
      if (row && row.value_json) {
        const cached = JSON.parse(row.value_json) as Profile;
        if (cached && cached.version === PROFILE_VERSION) {
          // File still missing → cache hit reuses exists:false profile.
          if (!cached.exists && onDiskMtime == null) return cached;
          // File present and mtime unchanged → cache hit.
          if (cached.exists && onDiskMtime != null && cached.source_mtime_ms === onDiskMtime) return cached;
        }
      }
    } catch (_e) { /* fall through to re-scan */ }
  }

  // Re-scan.
  const fresh = scanCairnMd(cairnPath);
  try {
    putScratch(db, blobRoot, {
      key: profileCacheKey(gitRoot),
      value: fresh,
      task_id: null,
      expires_at: null,
    });
  } catch (_e) { /* cache write best-effort */ }
  return fresh;
}
