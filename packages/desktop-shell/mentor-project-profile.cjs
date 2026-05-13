'use strict';

/**
 * Mentor project profile scanner.
 *
 * Reads a project's CAIRN.md (the per-project policy file — see
 * docs/CAIRN-md-spec.md) and emits a structured profile JSON that
 * mentor-policy / mentor-tick consume.
 *
 * The profile is cached in the scratchpad table under key
 *   project_profile/<project_id>
 * with `source_mtime_ms` tracking the underlying file's mtime so we
 * only re-scan when CAIRN.md actually changed.
 *
 * Strict read-only against the project filesystem (the scanner does
 * not write to CAIRN.md). The scratchpad write is the only side effect.
 *
 * No new dependencies — pure Node fs + crypto.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROFILE_VERSION = 1;

// ---------------------------------------------------------------------------
// Empty / default profile
// ---------------------------------------------------------------------------

function emptyProfile(absPath) {
  return {
    version: PROFILE_VERSION,
    source_path: absPath || null,
    exists: false,
    source_mtime_ms: null,
    source_sha1: null,
    scanned_at: Date.now(),
    project_name: null,
    goal: null,
    is_list: [],
    is_not_list: [],
    authority: {
      auto_decide: [],
      decide_and_announce: [],
      escalate: [],
    },
    constraints: [],
    known_answers: [],
    current_phase: {
      last_updated: null,
      phase: null,
      this_week: null,
      next_week: null,
    },
    raw_sections: {},
  };
}

// ---------------------------------------------------------------------------
// Markdown section parser — naive on purpose
// ---------------------------------------------------------------------------

/**
 * Split markdown content into sections keyed by their H2 header text.
 * Lines before the first H2 (e.g. the H1 title + lead paragraph) go into
 * the synthetic '_preamble' key.
 *
 * Header normalization: header text lowercased, whitespace collapsed,
 * trailing punctuation stripped. So `## Goal` and `## goal :` both key
 * to `goal`.
 */
function splitSections(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = { _preamble: [] };
  let current = '_preamble';
  for (const raw of lines) {
    const line = raw;
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = normalizeSectionKey(h2[1]);
      out[current] = out[current] || [];
      continue;
    }
    out[current].push(line);
  }
  // Join bodies back into single strings.
  const joined = {};
  for (const k of Object.keys(out)) {
    joined[k] = out[k].join('\n').trim();
  }
  return joined;
}

function normalizeSectionKey(headerText) {
  return String(headerText || '')
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[:,;.]+\s*$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Bullet extraction
// ---------------------------------------------------------------------------

/**
 * Pull bullet-list items out of a body. Each returned string is the
 * bullet text with the leading marker (`- ` / `* ` / `+ `) removed.
 *
 * Sub-bullets (indented) are concatenated to the parent with a single
 * space. Empty lines and non-bullet prose are ignored.
 */
function extractBullets(body) {
  const out = [];
  const lines = String(body || '').split('\n');
  let buf = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (m) {
      if (buf !== null) out.push(buf.trim());
      buf = m[1];
      continue;
    }
    if (buf !== null && /^\s+\S/.test(raw)) {
      // Continuation / sub-bullet — fold into parent.
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

/**
 * Classify an authority-section bullet by leading marker.
 *
 * Accepts either emoji (✅ / ⚠️ / 🛑) or ASCII tag (`auto:` / `announce:`
 * / `escalate:`) at the start of the bullet. Also tolerates Chinese
 * phrasing the spec uses ("Mentor auto-decide" / "decide + announce"
 * / "always escalate").
 *
 * Returns { bucket, text } where bucket is one of
 *   'auto_decide' | 'decide_and_announce' | 'escalate' | null
 * (null = unclassifiable; caller drops it).
 */
function classifyAuthorityBullet(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return { bucket: null, text: '' };

  // Emoji-prefixed
  if (trimmed.startsWith('✅')) {
    return { bucket: 'auto_decide', text: stripLeader(trimmed, ['✅']) };
  }
  if (trimmed.startsWith('⚠️') || trimmed.startsWith('⚠')) {
    return { bucket: 'decide_and_announce', text: stripLeader(trimmed, ['⚠️', '⚠']) };
  }
  if (trimmed.startsWith('🛑')) {
    return { bucket: 'escalate', text: stripLeader(trimmed, ['🛑']) };
  }

  // ASCII tag prefix
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

  // Phrase prefix (matches the spec's recommended wording verbatim).
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

function stripLeader(s, leaders) {
  let out = s;
  for (const lead of leaders) {
    if (out.startsWith(lead)) out = out.slice(lead.length).trim();
  }
  // Strip any single trailing ":" or "·" left over from "✅ Mentor auto-decide: foo".
  out = out.replace(/^mentor\s+auto-?decide[:\- ]*\s*/i, '');
  out = out.replace(/^mentor\s+decide\s*\+\s*announce[:\- ]*\s*/i, '');
  out = out.replace(/^always\s+escalate(\s+to\s+user)?[:\- ]*\s*/i, '');
  return out.trim();
}

function stripPrefix(s, re) {
  return String(s || '').replace(re, '').trim();
}

// ---------------------------------------------------------------------------
// IS / IS NOT bullets
// ---------------------------------------------------------------------------

/**
 * Classify an IS/IS-NOT bullet. Accepts `IS:` / `IS NOT:` prefix
 * (case-insensitive). Bullets without prefix go to neither bucket.
 */
function classifyIsBullet(line) {
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

/**
 * Each bullet is of the form `<pattern> => <answer>`. Whitespace is
 * tolerated around the `=>`. Bullets without `=>` are dropped.
 */
function parseKnownAnswers(body) {
  const out = [];
  for (const bullet of extractBullets(body)) {
    const m = bullet.match(/^(.*?)\s*=>\s*(.+)$/);
    if (!m) continue;
    const pattern = m[1].trim();
    const answer = m[2].trim();
    if (pattern && answer) out.push({ pattern, answer });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Current-phase parser
// ---------------------------------------------------------------------------

function parseCurrentPhase(body) {
  const out = { last_updated: null, phase: null, this_week: null, next_week: null };
  if (!body) return out;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^\*\*last updated\*\*\s*:?\s*(.+)$/i))) {
      out.last_updated = m[1].trim();
      continue;
    }
    if ((m = line.match(/^[-*+]\s*phase\s*:?\s*(.+)$/i))) {
      out.phase = m[1].trim();
      continue;
    }
    if ((m = line.match(/^[-*+]\s*this week\s*:?\s*(.+)$/i))) {
      out.this_week = m[1].trim();
      continue;
    }
    if ((m = line.match(/^[-*+]\s*next week\s*:?\s*(.+)$/i))) {
      out.next_week = m[1].trim();
      continue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// H1 / project-name extraction
// ---------------------------------------------------------------------------

function extractProjectName(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Goal extraction
// ---------------------------------------------------------------------------

function extractGoal(body) {
  if (!body) return null;
  // Pull first non-blank, non-marker, non-quote line.
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) continue;
    if (/^[-*+]\s+/.test(line)) {
      // Bullet — strip marker.
      return line.replace(/^[-*+]\s+/, '').trim();
    }
    return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section-key lookup (with synonyms)
// ---------------------------------------------------------------------------

const SECTION_SYNONYMS = {
  goal: ['goal', '目标'],
  is_isnot: ['what this project is / is not', 'what this project is/is not', 'project is / is not', 'is / is not', 'scope'],
  authority: ['mentor authority (decision delegation)', 'mentor authority', 'authority', 'decision delegation', '权限委托'],
  constraints: ['project constraints', 'constraints', 'project constraints (mentor + agent both follow)', '约束'],
  known_answers: ['known answers', '已知回答'],
  current_phase: ['current phase', 'current phase (auto-maintained, can be manually edited)', '当前阶段'],
};

function findSectionBody(sections, kind) {
  const candidates = SECTION_SYNONYMS[kind] || [];
  for (const c of candidates) {
    const key = normalizeSectionKey(c);
    if (Object.prototype.hasOwnProperty.call(sections, key) && sections[key]) {
      return sections[key];
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Public: scanCairnMd
// ---------------------------------------------------------------------------

/**
 * Scan a CAIRN.md file on disk.
 *
 * @param {string} filePath — absolute path to CAIRN.md (need not exist)
 * @returns {Profile}
 */
function scanCairnMd(filePath) {
  const abs = filePath ? path.resolve(filePath) : null;
  if (!abs) return emptyProfile(null);
  let stat;
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
  profile.current_phase = parseCurrentPhase(findSectionBody(sections, 'current_phase'));

  return profile;
}

// ---------------------------------------------------------------------------
// Scratchpad cache helpers
// ---------------------------------------------------------------------------

function profileCacheKey(projectId) {
  return `project_profile/${projectId}`;
}

/**
 * Read the cached profile from scratchpad. Returns null when no cache
 * row exists.
 *
 * @param {Database} db — better-sqlite3 handle
 * @param {string} projectId
 * @returns {Profile|null}
 */
function readCachedProfile(db, projectId) {
  if (!db || !projectId) return null;
  let row;
  try {
    row = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(profileCacheKey(projectId));
  } catch (_e) {
    return null;
  }
  if (!row) return null;
  try {
    const j = JSON.parse(row.value_json);
    if (!j || j.version !== PROFILE_VERSION) return null;
    return j;
  } catch (_e) {
    return null;
  }
}

/**
 * Write the profile JSON into scratchpad. ON CONFLICT UPDATE so reruns
 * overwrite. No-op when db / projectId missing.
 */
function writeCachedProfile(db, projectId, profile) {
  if (!db || !projectId || !profile) return false;
  const now = Date.now();
  const key = profileCacheKey(projectId);
  try {
    db.prepare(`
      INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
      VALUES (?, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(profile), now, now);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Resolve CAIRN.md path for a project. project_root is the directory
 * tree, so the file lives at `<root>/CAIRN.md`.
 */
function resolveCairnMdPath(project) {
  if (!project) return null;
  const root = project.project_root || project.cwd || project.repo_path || null;
  if (!root) return null;
  return path.join(root, 'CAIRN.md');
}

/**
 * High-level "get me the current profile" — checks cache, re-scans if
 * the file mtime advanced, writes back to cache. Used by mentor-tick.
 *
 * Returns the profile (always a valid Profile object; `exists: false`
 * when CAIRN.md isn't present).
 */
function loadProfile(db, project) {
  const cairnPath = resolveCairnMdPath(project);
  if (!cairnPath) return emptyProfile(null);

  let onDiskMtime = null;
  try { onDiskMtime = fs.statSync(cairnPath).mtimeMs; } catch (_e) { onDiskMtime = null; }

  const cached = readCachedProfile(db, project.id);
  if (cached && cached.exists && onDiskMtime != null && cached.source_mtime_ms === onDiskMtime) {
    return cached;
  }
  if (cached && !cached.exists && onDiskMtime == null) {
    return cached;
  }

  const fresh = scanCairnMd(cairnPath);
  writeCachedProfile(db, project.id, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// Match helpers — used by mentor-policy
// ---------------------------------------------------------------------------

// Stopwords for token-overlap fallback in matchBucket. Kept short on
// purpose — extending the list shifts semantics for every CAIRN.md
// in the world. Lowercase, length-2-or-more only matters here.
const _STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'at', 'by',
  'and', 'or', 'but', 'is', 'are', 'be', 'been', 'have', 'has', 'do',
  'does', 'did', 'i', 'we', 'you', 'it', 'this', 'that', 'with', 'from',
  'should', 'would', 'could', 'when', 'where', 'how', 'why', 'what', 'which',
  'over', 'up', 'as', 'so', 'if', 'then', 'than', 'too', 'about',
]);

function _tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-]+/i)
    .filter(t => t.length >= 3 && !_STOPWORDS.has(t));
}

/**
 * Match a bullet list against a free-form corpus.
 *
 * Two-stage matcher:
 *   1. Whole-bullet substring (lowercased) — wins immediately when the
 *      author wrote a short, pithy rule (e.g. "npm publish").
 *   2. Token-overlap fallback — at least 2 content tokens of the bullet
 *      (length ≥ 3, not in the small stopword set) appear in the
 *      corpus. Handles longer descriptive bullets like
 *        "retry transient test failures up to 2x"
 *      matching a question like
 *        "Should we retry transient test failures here?"
 *
 * The substring path is canonical; the token-overlap fallback is the
 * graceful degradation for verbose authors. Both lowercase.
 *
 * @param {string[]} bullets
 * @param {string} text
 * @returns {string|null} the matched bullet text, or null
 */
function matchBucket(bullets, text) {
  if (!Array.isArray(bullets) || !text) return null;
  const corpus = String(text).toLowerCase();
  // Stage 1 — substring
  for (const b of bullets) {
    if (!b) continue;
    if (corpus.includes(b.toLowerCase())) return b;
  }
  // Stage 2 — token overlap (≥ 2 shared content tokens, contiguous order
  // not required)
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
 * Match a question against the known_answers list. Returns the first
 * matching { pattern, answer } pair, or null.
 */
function matchKnownAnswer(knownAnswers, question) {
  if (!Array.isArray(knownAnswers) || !question) return null;
  const q = String(question).toLowerCase();
  for (const pair of knownAnswers) {
    if (!pair || !pair.pattern) continue;
    if (q.includes(String(pair.pattern).toLowerCase())) return pair;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  PROFILE_VERSION,
  // pure parser
  scanCairnMd,
  emptyProfile,
  splitSections,
  extractBullets,
  classifyAuthorityBullet,
  classifyIsBullet,
  parseKnownAnswers,
  parseCurrentPhase,
  extractProjectName,
  extractGoal,
  normalizeSectionKey,
  findSectionBody,
  // cache layer
  profileCacheKey,
  readCachedProfile,
  writeCachedProfile,
  resolveCairnMdPath,
  loadProfile,
  // match helpers
  matchBucket,
  matchKnownAnswer,
};
