'use strict';

/**
 * Worker Launcher v1 — user-authorized, single-shot spawn of one
 * coding agent (Claude Code, Codex, or a fixture provider) inside a
 * managed project's working directory.
 *
 * Hard product boundary (PRODUCT.md §1.3 / §6.4 / §7):
 *   - Cairn never auto-launches. Every call here originates from a
 *     user click in the panel. There is no scheduler, no retry loop,
 *     no orchestration loop. Each call is one round.
 *   - Cairn does not write code itself; the worker writes code in
 *     the managed repo. cairn.db, ~/.claude, ~/.codex are NEVER
 *     written by this module.
 *   - Cairn does not push, fetch, checkout, reset, clean, or stash.
 *     The worker may, but only because the worker is doing the work.
 *   - Cairn's review of the round is advisory, not gating.
 *
 * Run artifacts (per-run directory, owned by Cairn, scoped to one
 * round of work):
 *   ~/.cairn/worker-runs/<runId>/run.json   metadata
 *   ~/.cairn/worker-runs/<runId>/prompt.txt the worker's input prompt
 *   ~/.cairn/worker-runs/<runId>/tail.log   stdout+stderr tail (capped)
 *
 * Tail log is truncated to MAX_LOG_BYTES (128KB) by a chunk-rotation
 * strategy: the oldest 32KB of the tail file is dropped when the file
 * grows past 128KB. We bound disk usage and keep the last segment
 * intact for parsing the Worker Report.
 *
 * Process model: each run is one child process owned by this Electron
 * main. We track them in `runRegistry` (in-memory) so stop / status /
 * tail can find them by run_id without re-reading disk every poll.
 * The registry is rebuilt opportunistically on require if Electron
 * restarts (we re-read run.json files; live-process state is lost
 * but persisted runs still appear in list with status='unknown').
 *
 * Process killing: child_process.spawn with detached:false. On
 * Windows we use `taskkill /F /T /PID <pid>` (tree kill — necessary
 * because claude.cmd spawns node). On POSIX we send SIGTERM to the
 * PID; the user's CLI is expected to clean up on TERM.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const RUNS_DIRNAME = 'worker-runs';
const MAX_LOG_BYTES = 128 * 1024;
const LOG_DROP_BYTES = 32 * 1024;
const PROMPT_MAX_BYTES = 256 * 1024;
const RUN_ID_BYTES = 6;

const STATUS_VALUES = new Set([
  'queued',     // run.json written, child not started yet
  'running',    // child spawned, not yet exited
  'exited',     // child exited with status 0
  'failed',     // child exited non-zero
  'stopped',    // user stopped the run
  'unknown',    // process state lost (Electron restart)
]);

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------
//
// Each provider knows:
//   - id:           stable string id
//   - displayName:  user-facing label
//   - command:      the executable to find on PATH (without .cmd suffix)
//   - argvFor(promptPath): how to invoke given the prompt file path
//   - acceptsStdin: if true, prompt is also written to child stdin
//   - description:  one-line user-visible label
//
// We deliberately keep the list small: claude-code (real), codex
// (real), fixture-echo (test fixture that emits a Worker Report and
// exits). Adding a provider is intentionally a code change (and a
// review) rather than user config — Cairn can't be tricked into
// running an arbitrary binary by editing a JSON file.

const PROVIDERS = {
  'claude-code': {
    id: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude',
    description: 'Anthropic Claude Code CLI (one-shot mode)',
    // Claude Code reads the prompt from stdin in non-interactive mode.
    // We pass --print so it exits after the response, and pass the
    // prompt via stdin (no argv injection of user content).
    argvFor: (_promptPath) => ['--print'],
    acceptsStdin: true,
  },
  'codex': {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    description: 'OpenAI Codex CLI',
    argvFor: (_promptPath) => ['exec'],
    acceptsStdin: true,
  },
  'fixture-echo': {
    id: 'fixture-echo',
    displayName: 'Fixture (echo)',
    command: process.execPath, // node itself; never depends on user env
    description: 'Local fixture that emits a Worker Report and exits (no LLM)',
    // Pass the prompt path via the CAIRN_FIXTURE_PROMPT env var to
    // dodge Node's `--` end-of-options stripping (which would erase
    // the path from process.argv on `node -e SCRIPT -- PATH`).
    argvFor: (_promptPath) => ['-e', FIXTURE_ECHO_SCRIPT],
    acceptsStdin: false,
    fixtureEnv: (promptPath) => ({ CAIRN_FIXTURE_PROMPT: promptPath }),
  },
};

// Inlined as a string so the launcher has no dep on a separate file
// and the smoke can grep for the exact behavior. The fixture reads
// the prompt path, writes a small acknowledgement + a Worker Report
// block, then exits 0.
const FIXTURE_ECHO_SCRIPT = `
'use strict';
const fs = require('fs');
const promptPath = process.env.CAIRN_FIXTURE_PROMPT;
const prompt = promptPath ? fs.readFileSync(promptPath, 'utf8') : '';
const titleMatch = prompt.match(/^# Goal\\s*\\n([^\\n]+)/m);
const title = titleMatch ? titleMatch[1].slice(0, 120) : 'fixture round';
process.stdout.write('[fixture-echo] received prompt of ' + prompt.length + ' chars\\n');
process.stdout.write('[fixture-echo] managed-loop sanity:\\n');
const m = prompt.match(/# Managed project[\\s\\S]*?(?=\\n# )/);
if (m) process.stdout.write(m[0].split('\\n').slice(0, 6).join('\\n') + '\\n...\\n');
process.stdout.write('\\n## Worker Report\\n');
process.stdout.write('### Completed\\n');
process.stdout.write('- Acknowledged prompt: ' + title + '\\n');
process.stdout.write('### Remaining\\n');
process.stdout.write('- Real worker did not run; this is the fixture provider.\\n');
process.stdout.write('### Blockers\\n');
process.stdout.write('### Next\\n');
process.stdout.write('- Wire a real provider before relying on this output.\\n');
process.exit(0);
`;

function listProviderIds() { return Object.keys(PROVIDERS); }

function getProvider(id) { return PROVIDERS[id] || null; }

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Locate an executable by command name. Returns the absolute path or
 * null. On Windows we look for `.cmd` shims first (npm-installed CLIs
 * almost always ship as .cmd). We do NOT recursively probe — this is
 * one stat per PATH entry per probe.
 *
 * @param {string} cmd
 * @returns {string|null}
 */
function whichCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  // Always-available case: absolute path that exists.
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;
  const PATH = process.env.PATH || process.env.Path || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.BAT;.CMD').split(';').map(s => s.toLowerCase())
    : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch (_e) { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Probe the catalog: which providers have their CLI on PATH?
 * fixture-echo is always available (uses the Node already running).
 *
 * @returns {Array<{id, displayName, available, command, resolved_path, description, error?}>}
 */
function detectWorkerProviders() {
  const out = [];
  for (const id of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[id];
    if (id === 'fixture-echo') {
      out.push({
        id, displayName: p.displayName, description: p.description,
        available: true, command: 'node', resolved_path: process.execPath,
      });
      continue;
    }
    const resolved = whichCommand(p.command);
    out.push({
      id, displayName: p.displayName, description: p.description,
      available: !!resolved,
      command: p.command,
      resolved_path: resolved,
      error: resolved ? null : 'not_found_on_path',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run directory + metadata
// ---------------------------------------------------------------------------

function runsDir(home) {
  return path.join((home || os.homedir()), '.cairn', RUNS_DIRNAME);
}
function runDir(runId, home) {
  const safe = String(runId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  return path.join(runsDir(home), safe);
}
function runFile(runId, name, home) {
  return path.join(runDir(runId, home), name);
}

function newRunId() { return 'wr_' + crypto.randomBytes(RUN_ID_BYTES).toString('hex'); }

function ensureRunDir(runId, home) {
  try { fs.mkdirSync(runDir(runId, home), { recursive: true }); } catch (_e) {}
}

function safeReadFile(p, maxBytes) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(p, 'r');
    try {
      const len = Math.min(stat.size, maxBytes || PROMPT_MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_e) { return null; }
}

function readRunMetadata(runId, home) {
  const txt = safeReadFile(runFile(runId, 'run.json', home), 64 * 1024);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (_e) { return null; }
}

function writeRunMetadata(runId, meta, home) {
  ensureRunDir(runId, home);
  const file = runFile(runId, 'run.json', home);
  const tmp = file + '.tmp.' + crypto.randomBytes(3).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (_e) { return { ok: false, error: 'write_failed' }; }
}

// ---------------------------------------------------------------------------
// Bounded tail log
// ---------------------------------------------------------------------------
//
// Append `chunk` to the run's tail.log. If the file would exceed
// MAX_LOG_BYTES, drop the OLDEST LOG_DROP_BYTES bytes and continue
// appending to the trimmed file. We never write line markers or
// truncation markers in the user's log because the Worker Report
// extractor relies on contiguous "## Worker Report" parsing.

function appendToTailLog(runId, chunk, home) {
  if (!chunk || !chunk.length) return;
  const file = runFile(runId, 'tail.log', home);
  let curSize = 0;
  try { curSize = fs.statSync(file).size; } catch (_e) {}
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
  if (curSize + incoming.length > MAX_LOG_BYTES) {
    // Read existing tail (last MAX_LOG_BYTES - LOG_DROP_BYTES bytes),
    // overwrite the file with the kept tail, then append.
    const keepBytes = MAX_LOG_BYTES - LOG_DROP_BYTES - incoming.length;
    if (keepBytes <= 0) {
      // Incoming alone exceeds budget — keep only the last MAX_LOG_BYTES
      // bytes of incoming.
      try {
        fs.writeFileSync(file, incoming.slice(Math.max(0, incoming.length - MAX_LOG_BYTES)));
      } catch (_e) {}
      return;
    }
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(curSize, keepBytes));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, curSize - buf.length));
      fs.closeSync(fd);
      fs.writeFileSync(file, buf);
      fs.appendFileSync(file, incoming);
    } catch (_e) {
      // Last resort: overwrite with just the incoming chunk.
      try { fs.writeFileSync(file, incoming); } catch (_e2) {}
    }
    return;
  }
  try { fs.appendFileSync(file, incoming); } catch (_e) {}
}

function tailRunLog(runId, limitBytes, home) {
  const file = runFile(runId, 'tail.log', home);
  let stat;
  try { stat = fs.statSync(file); } catch (_e) { return ''; }
  const want = Math.min(stat.size, limitBytes || MAX_LOG_BYTES);
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, Math.max(0, stat.size - want));
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_e) { return ''; }
}

// ---------------------------------------------------------------------------
// Secret hygiene helpers
// ---------------------------------------------------------------------------
//
// We forward parent env so the user's API key reaches the CLI. We do
// NOT write the env to run.json; we record only a list of NAMES of
// env vars known to be sensitive (so debugging "is the key set?" is
// possible without leaking the value).

const SENSITIVE_ENV_NAMES = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN',
  'GH_TOKEN', 'CAIRN_PUSH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY',
];
function summarizeEnvHygiene(env) {
  const e = env || process.env;
  const present = [];
  for (const k of SENSITIVE_ENV_NAMES) if (typeof e[k] === 'string' && e[k].length > 0) present.push(k);
  return { sensitive_env_present: present };
}

// ---------------------------------------------------------------------------
// Process registry (in-memory map of running children)
// ---------------------------------------------------------------------------

/** @type {Map<string, { child, runId, home, startedAt, status }>} */
const runRegistry = new Map();

function registryGet(runId) { return runRegistry.get(runId) || null; }

function registryDelete(runId) { runRegistry.delete(runId); }

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * Launch one round of work.
 *
 * @param {object} input
 * @param {string} input.provider       provider id (claude-code / codex / fixture-echo)
 * @param {string} input.cwd            absolute path of the managed project
 * @param {string} input.prompt         the prompt text (caller-built)
 * @param {string} input.iteration_id   binding for project-iterations
 * @param {string} input.project_id     for run.json metadata
 * @param {object} [opts]
 * @param {string} [opts.home]          override ~/ (testing)
 * @param {object} [opts.env]           override env (testing)
 * @param {function} [opts.onLine]      called with each stdout/stderr line (testing)
 *
 * @returns {{ ok:boolean, run_id?, run?, error? }}
 *
 * Synchronous up to spawn — by the time the caller gets the run_id
 * the child is already started (or has reported a spawn failure).
 * Stdout/stderr are streamed to tail.log; status updates are
 * persisted to run.json on each transition.
 */
function launchWorker(input, opts) {
  const o = opts || {};
  const i = input || {};
  if (!i.provider) return { ok: false, error: 'provider_required' };
  if (!i.cwd)      return { ok: false, error: 'cwd_required' };
  if (typeof i.prompt !== 'string' || !i.prompt.trim()) return { ok: false, error: 'prompt_required' };

  const provider = getProvider(i.provider);
  if (!provider) return { ok: false, error: 'unknown_provider' };
  if (!fs.existsSync(i.cwd)) return { ok: false, error: 'cwd_not_found' };

  // Resolve the executable. fixture-echo always uses node; real
  // providers must exist on PATH or fail before spawn.
  let resolvedExe;
  if (provider.id === 'fixture-echo') {
    resolvedExe = process.execPath;
  } else {
    resolvedExe = whichCommand(provider.command);
    if (!resolvedExe) return { ok: false, error: 'provider_unavailable', provider: provider.id };
  }

  const runId = newRunId();
  const home = o.home;
  ensureRunDir(runId, home);

  // Prompt → file (canonical artifact). The CLI always reads from
  // stdin in our wiring (more portable than --file flags), but we
  // also keep the file so users can audit the exact prompt that was
  // sent.
  const promptPath = runFile(runId, 'prompt.txt', home);
  try { fs.writeFileSync(promptPath, i.prompt.slice(0, PROMPT_MAX_BYTES), 'utf8'); }
  catch (_e) { return { ok: false, error: 'prompt_write_failed' }; }

  // Build env. Start with caller's (or process) env; if the provider
  // declares a fixtureEnv (test fixture only), merge that in so the
  // fixture can find its prompt path without going through argv.
  const baseEnv = o.env || process.env;
  const env = (typeof provider.fixtureEnv === 'function')
    ? Object.assign({}, baseEnv, provider.fixtureEnv(promptPath))
    : baseEnv;
  const argv = provider.argvFor(promptPath);

  const startedAt = Date.now();
  const meta = {
    run_id: runId,
    provider: provider.id,
    cwd: i.cwd,
    project_id: i.project_id || null,
    iteration_id: i.iteration_id || null,
    prompt_hash: crypto.createHash('sha256').update(i.prompt).digest('hex').slice(0, 16),
    prompt_bytes: Buffer.byteLength(i.prompt, 'utf8'),
    started_at: startedAt,
    ended_at: null,
    status: 'queued',
    exit_code: null,
    pid: null,
    resolved_exe: resolvedExe,
    argv,
    env_hygiene: summarizeEnvHygiene(env),
  };
  writeRunMetadata(runId, meta, home);

  // Spawn — argv only, no shell. Windows .cmd shims are launched
  // by spawning cmd.exe /c "<cmd>" with each argv element passed as
  // its own arg. We let Node's child_process do the cmd.exe escaping
  // because node 16+ rejects untrusted .bat/.cmd content with
  // shell:false (CVE-2024-27980 family) — except when the resolved
  // path is absolute and the args don't contain shell metacharacters,
  // which is our case (no user input ever reaches argv: provider.argvFor
  // returns a fixed shape with at most a Cairn-owned path).
  let child;
  try {
    const spawnOpts = {
      cwd: i.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    };
    // Windows .cmd / .bat shims: invoke explicitly via `cmd.exe /C`
    // rather than relying on Node's shell:true heuristic. argv stays
    // Cairn-owned (no user-supplied strings here) so we never need
    // shell-quoting; cmd.exe gets a fixed argv shape.
    let exec = resolvedExe;
    let execArgv = argv;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedExe)) {
      exec = process.env.ComSpec || 'cmd.exe';
      execArgv = ['/d', '/s', '/c', resolvedExe, ...argv];
    }
    child = spawn(exec, execArgv, spawnOpts);
  } catch (e) {
    meta.status = 'failed';
    meta.ended_at = Date.now();
    meta.error = 'spawn_threw';
    writeRunMetadata(runId, meta, home);
    return { ok: false, error: 'spawn_threw', run_id: runId };
  }

  if (child.pid == null) {
    meta.status = 'failed';
    meta.ended_at = Date.now();
    meta.error = 'no_pid';
    writeRunMetadata(runId, meta, home);
    return { ok: false, error: 'no_pid', run_id: runId };
  }

  meta.status = 'running';
  meta.pid = child.pid;
  writeRunMetadata(runId, meta, home);

  // Stream stdin once.
  if (provider.acceptsStdin && child.stdin) {
    try { child.stdin.end(i.prompt); } catch (_e) { /* ignore */ }
  } else if (child.stdin) {
    try { child.stdin.end(); } catch (_e) {}
  }

  // Stream stdout/stderr to tail.log. We DO NOT scrub the log because
  // doing so could corrupt the Worker Report block; instead we rely
  // on the provider not echoing the env (Claude Code / Codex don't),
  // and on the caller never putting a secret in the prompt itself
  // (Cairn-built prompts contain no env vars — see prompt-pack).
  const onChunk = (buf) => {
    appendToTailLog(runId, buf, home);
    if (typeof o.onLine === 'function') {
      try { o.onLine(buf.toString('utf8')); } catch (_e) {}
    }
  };
  if (child.stdout) child.stdout.on('data', onChunk);
  if (child.stderr) child.stderr.on('data', onChunk);

  child.on('error', (err) => {
    const m = readRunMetadata(runId, home) || meta;
    m.status = 'failed';
    m.ended_at = Date.now();
    m.error = String(err && err.code || err && err.message || 'spawn_error').slice(0, 80);
    writeRunMetadata(runId, m, home);
    registryDelete(runId);
  });

  child.on('exit', (code, signal) => {
    const m = readRunMetadata(runId, home) || meta;
    m.ended_at = Date.now();
    m.exit_code = code;
    m.signal = signal || null;
    if (m.status === 'stopped') {
      // user-initiated stop — keep status, just record exit
    } else if (code === 0) {
      m.status = 'exited';
    } else {
      m.status = 'failed';
    }
    writeRunMetadata(runId, m, home);
    registryDelete(runId);
  });

  runRegistry.set(runId, { child, runId, home, startedAt, status: 'running' });

  return { ok: true, run_id: runId, run: meta };
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Stop one run by id. On Windows we use taskkill /F /T because the
 * .cmd shim spawns node and SIGTERM to the shim doesn't propagate.
 * On POSIX we send SIGTERM, then escalate to SIGKILL after 2s if the
 * child is still alive.
 *
 * Status transitions to 'stopped' regardless of whether the child
 * was actually alive — caller can re-poll for the exit code.
 */
function stopWorkerRun(runId, opts) {
  const o = opts || {};
  const entry = registryGet(runId);
  const home = (entry && entry.home) || o.home;
  const meta = readRunMetadata(runId, home);
  if (!meta) return { ok: false, error: 'run_not_found' };
  if (meta.status !== 'running' && meta.status !== 'queued') {
    return { ok: true, status: meta.status, already: true };
  }
  meta.status = 'stopped';
  writeRunMetadata(runId, meta, home);

  if (entry && entry.child && !entry.child.killed && meta.pid) {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(meta.pid)], {
          stdio: 'ignore', windowsHide: true, timeout: 5000,
        });
      } catch (_e) {}
    } else {
      try { entry.child.kill('SIGTERM'); } catch (_e) {}
      setTimeout(() => {
        try { if (!entry.child.killed) entry.child.kill('SIGKILL'); } catch (_e) {}
      }, 2000).unref();
    }
  }
  return { ok: true, status: 'stopped' };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

function getWorkerRun(runId, opts) {
  const o = opts || {};
  const meta = readRunMetadata(runId, o.home);
  if (!meta) return null;
  // Refresh in-memory status — if registry says running but child is
  // gone, downgrade to 'unknown'. This catches Electron restart.
  const entry = registryGet(runId);
  if ((meta.status === 'running' || meta.status === 'queued') && !entry) {
    meta.status = 'unknown';
  }
  return meta;
}

function listWorkerRuns(projectId, opts) {
  const o = opts || {};
  const dir = runsDir(o.home);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_e) { return []; }
  const out = [];
  for (const e of entries) {
    const meta = readRunMetadata(e, o.home);
    if (!meta) continue;
    if (projectId && meta.project_id && meta.project_id !== projectId) continue;
    out.push(meta);
  }
  out.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  return out;
}

// ---------------------------------------------------------------------------
// Worker Report extraction (deterministic, never LLM)
// ---------------------------------------------------------------------------
//
// The prompt asks the worker to emit a `## Worker Report` block at
// the end of its run. We scan the LAST occurrence of that header in
// the tail log and parse the four standard sections:
//   ### Completed / ### Remaining / ### Blockers / ### Next
//
// If the header isn't found, return { ok: false, error: 'no_report_block' }.
// Caller can then prompt the user to paste the report manually.

function extractWorkerReport(runId, opts) {
  const o = opts || {};
  const tail = tailRunLog(runId, o.bytes || MAX_LOG_BYTES, o.home);
  if (!tail) return { ok: false, error: 'no_log' };
  return extractReportFromText(tail);
}

const SECTION_RX = /^###\s+(Completed|Remaining|Blockers?|Next)\s*$/i;

// Workers commonly fill an empty section with one of these placeholder
// strings (claude-code typically writes "- (none)" when nothing belongs
// in Blockers/Remaining). Treat them as empty so the review layer
// doesn't see phantom items and flip to `blocked`.
const NONE_SENTINEL_RX = /^(?:[\s\-*•.–—]|n\/a|none|nothing|nil|empty|no(?:ne)?\b)+\.?$/i;
function isNoneSentinel(s) {
  if (typeof s !== 'string') return true;
  const t = s.trim();
  if (!t) return true;
  // strip surrounding parens / brackets, e.g. "(none)" -> "none"
  const stripped = t.replace(/^[\(\[\{<]+|[\)\]\}>]+$/g, '').trim();
  return NONE_SENTINEL_RX.test(stripped);
}

function extractReportFromText(text) {
  if (typeof text !== 'string') return { ok: false, error: 'no_log' };
  // Find the LAST "## Worker Report" header — workers may print
  // intermediate examples; we want the final summary. Using matchAll
  // here (over a manual rx.exec loop) keeps audit greps for `.exec(`
  // clean of false positives in this module.
  const matches = Array.from(text.matchAll(/^##\s+Worker\s+Report\s*$/gim));
  if (!matches.length) return { ok: false, error: 'no_report_block' };
  const start = matches[matches.length - 1].index;
  const block = text.slice(start);

  const fields = { completed: [], remaining: [], blockers: [], next: [] };
  let current = null;
  const lines = block.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) { // skip the header line
    const line = lines[i];
    const trimmed = line.trim();
    const sect = trimmed.match(SECTION_RX);
    if (sect) {
      const k = sect[1].toLowerCase();
      if (k.startsWith('blocker')) current = 'blockers';
      else current = k;
      continue;
    }
    // Stop at a sibling ## or # (next major header)
    if (/^##\s+/.test(trimmed) && !/^##\s+Worker\s+Report/i.test(trimmed)) break;
    // Empty bullet — a bare "-" or "*" with no content is the
    // worker's way of saying "this section is empty". Skip; do
    // NOT push it as an item (otherwise an empty Blockers section
    // surfaces as one phantom blocker and review flips to blocked).
    if (current && /^[-*•]\s*$/.test(trimmed)) continue;
    if (current && /^[-*•]\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[-*•]\s+/, '').trim();
      if (item && !isNoneSentinel(item)) fields[current].push(item);
    } else if (current && trimmed && !/^#/.test(trimmed)) {
      // accept non-bullet lines as items if they're short
      if (trimmed.length <= 400 && !isNoneSentinel(trimmed)) fields[current].push(trimmed);
    }
  }
  return {
    ok: true,
    title: '[auto-extracted] Worker Report',
    completed: fields.completed.slice(0, 30),
    remaining: fields.remaining.slice(0, 30),
    blockers: fields.blockers.slice(0, 30),
    next_steps: fields.next.slice(0, 30),
  };
}

module.exports = {
  // constants
  STATUS_VALUES,
  MAX_LOG_BYTES,
  LOG_DROP_BYTES,
  PROMPT_MAX_BYTES,
  RUNS_DIRNAME,
  PROVIDERS,
  // detection
  whichCommand,
  detectWorkerProviders,
  listProviderIds,
  getProvider,
  // run management
  launchWorker,
  stopWorkerRun,
  getWorkerRun,
  listWorkerRuns,
  tailRunLog,
  // report extraction
  extractWorkerReport,
  extractReportFromText,
  // paths
  runsDir,
  runDir,
  runFile,
  // env hygiene (testable)
  summarizeEnvHygiene,
  SENSITIVE_ENV_NAMES,
};
