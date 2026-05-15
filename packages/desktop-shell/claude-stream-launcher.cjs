'use strict';

/**
 * claude-stream-launcher.cjs — spawn Claude Code in real-time NDJSON
 * streaming mode (`--output-format stream-json --input-format stream-json`).
 *
 * Subagent verdicts (sonnet A + sonnet B) 2026-05-14:
 *   Pattern borrowed from Agora (sunrf-renlab-ai/Agora, local/src/runner/
 *   claude.ts). `claude --print` is a one-shot mode for shell pipelines;
 *   the right tool for daemon-class apps is `--output-format stream-json`
 *   which emits NDJSON events (assistant / user / system / result / log /
 *   control_request) over stdout, accepting NDJSON control responses over
 *   stdin. This launcher exists alongside `worker-launcher.cjs::launchWorker`
 *   (which Mode B still uses with --print); we do NOT route through it
 *   because the I/O lifecycles are fundamentally different:
 *
 *     - launchWorker: stdin.end(prompt) once → wait for exit → finalize
 *       (one-shot)
 *     - this launcher: write prompt as one NDJSON user-turn message →
 *       keep stdin OPEN → consume NDJSON events as they arrive →
 *       finalize on 'result' event (multi-turn capable, real-time)
 *
 * This file OWNS all I/O for the claude-stream provider: spawn, stdin
 * write, stdout NDJSON parsing, tail.log (text-only, for backward compat
 * with mentor-tick LLM helpers), stream_events.jsonl (raw events for
 * panel introspection), run.json status writes, watchdog timer.
 *
 * Phase 1 (2026-05-14 d51349c): basic streaming + NDJSON parse + file writes.
 * Phase 3 (this commit): per-spawn --mcp-config temp file. Reads project
 *   `.mcp.json`, overrides with canonical cairn-wedge entry, writes to
 *   `os.tmpdir()/cairn-mcp-<runId>.json`. Spawn argv carries
 *   `--mcp-config <path> --strict-mcp-config`. Temp file cleaned up
 *   on child exit. This unblocks Phase 2 (resume across plan steps
 *   needs stable MCP attachment).
 * Phase 2 (this commit): --resume <sessionId> argv thread-through.
 *   Caller passes `input.resumeSessionId` if continuing a prior run;
 *   stream-launcher captures `session_id` from `result` events (already
 *   in meta.session_id from Phase 1) — caller (mode-a-spawner) persists
 *   it to scratchpad on its side.
 *
 * Public API:
 *   launchStreamWorker(input, opts) → { ok, run_id, run } | { ok:false, error }
 *
 * Input:
 *   { cwd, prompt, project_id, iteration_id, env?, resumeSessionId? }
 * Opts:
 *   { home?, onLine?, onEvent?, idleTimeoutMs?, mcpConfigTmpDir? }
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createNdjsonStream } = require('./ndjson-stream.cjs');
const cairnLog = require('./cairn-log.cjs');
const mcpConfigBuilder = require('./claude-mcp-config.cjs');

const RUN_DIR_NAME = 'worker-runs';
const MAX_TAIL_BYTES = 128 * 1024; // 128 KB — matches worker-launcher
const DEFAULT_IDLE_TIMEOUT_MS = parseInt(process.env.CAIRN_MODE_A_STREAM_TIMEOUT_MS || '', 10) || (10 * 60 * 1000);
const SUPPORTED_PROVIDER = 'claude-code';

function newRunId() {
  return 'wr_' + crypto.randomBytes(6).toString('hex');
}

function homeBase(home) {
  return path.join(home || os.homedir(), '.cairn', RUN_DIR_NAME);
}

function runDir(runId, home) {
  return path.join(homeBase(home), runId);
}

function runFile(runId, name, home) {
  return path.join(runDir(runId, home), name);
}

function ensureRunDir(runId, home) {
  fs.mkdirSync(runDir(runId, home), { recursive: true });
}

function writeRunMeta(runId, meta, home) {
  try {
    fs.writeFileSync(runFile(runId, 'run.json', home), JSON.stringify(meta, null, 2), 'utf8');
  } catch (_e) { /* swallow — disk full shouldn't crash launcher */
    cairnLog.info('claude-stream-launcher', 'run_meta_write_failed', { message: (_e && _e.message) || String(_e) });
  }
}

function readRunMeta(runId, home) {
  try {
    return JSON.parse(fs.readFileSync(runFile(runId, 'run.json', home), 'utf8'));
  } catch (_e) { return null; }
}

/**
 * Append a chunk to tail.log with a hard byte cap. We trim the FILE
 * (truncate-from-front semantics) once it crosses MAX_TAIL_BYTES so
 * downstream readers (mentor-tick LLM helpers) see recent output.
 */
function appendTail(runId, chunk, home) {
  try {
    const p = runFile(runId, 'tail.log', home);
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    fs.appendFileSync(p, buf);
    const st = fs.statSync(p);
    if (st.size > MAX_TAIL_BYTES * 2) {
      // Cheap-and-correct: rewrite the last MAX_TAIL_BYTES bytes only.
      const fd = fs.openSync(p, 'r');
      const tail = Buffer.alloc(MAX_TAIL_BYTES);
      fs.readSync(fd, tail, 0, MAX_TAIL_BYTES, st.size - MAX_TAIL_BYTES);
      fs.closeSync(fd);
      fs.writeFileSync(p, tail);
    }
  } catch (_e) { /* swallow — disk full shouldn't crash launcher */
    cairnLog.info('claude-stream-launcher', 'tail_log_append_failed', { message: (_e && _e.message) || String(_e) });
  }
}

/**
 * Append raw NDJSON line to stream_events.jsonl. Append-only. Phase 1
 * does NOT rotate; Phase 1.5 can add rotation if a real session
 * produces > 10 MB of events. For now (~150 events × 2 KB avg = ~300 KB
 * typical), unbounded growth is acceptable for the duration of one run.
 */
function appendStreamEvent(runId, rawLine, home) {
  try {
    const p = runFile(runId, 'stream_events.jsonl', home);
    fs.appendFileSync(p, rawLine + '\n', 'utf8');
  } catch (_e) { /* swallow — disk full shouldn't crash launcher */
    cairnLog.info('claude-stream-launcher', 'stream_event_append_failed', { message: (_e && _e.message) || String(_e) });
  }
}

/**
 * Extract human-readable text from an `assistant` event so tail.log
 * stays useful for LLM helpers that expect prose, not JSON.
 *
 * Event shape (Claude SDK):
 *   { type:'assistant', message: { role:'assistant', content: [
 *     { type:'text', text:'...' },
 *     { type:'tool_use', id, name, input },
 *   ] } }
 *
 * We append text blocks verbatim and summarize tool uses as one line
 * each: `[tool_use: <name>] <one-line preview>`. Other event types
 * (`result`, `system`, `log`, etc.) are NOT appended to tail.log —
 * they live in stream_events.jsonl only.
 */
function extractAssistantText(ev) {
  if (!ev || ev.type !== 'assistant') return '';
  const msg = ev.message;
  if (!msg || !Array.isArray(msg.content)) return '';
  const parts = [];
  for (const block of msg.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const name = String(block.name || '?');
      const preview = block.input
        ? JSON.stringify(block.input).slice(0, 120)
        : '';
      parts.push('[tool_use: ' + name + '] ' + preview);
    }
  }
  return parts.length > 0 ? parts.join('\n') + '\n' : '';
}

/**
 * Resolve a command on PATH (parent-process resolution). Mirrors
 * worker-launcher.cjs::whichCommand semantics so smokes that PATH-prepend
 * a fake binary work the same way for both launchers.
 *
 * Windows extension order (2026-05-14 鸭总 panel crash fix):
 *   On Windows, npm installs shims under %AppData%\Roaming\npm as a
 *   TRIO — `claude` (no ext, POSIX shell script for Git Bash),
 *   `claude.cmd` (cmd.exe shim), `claude.ps1` (PowerShell shim).
 *   `node:child_process.spawn()` cannot execute the no-extension
 *   POSIX script on Windows — it throws `ENOENT` because the file
 *   has no executable association. We must prefer the .cmd / .exe /
 *   .bat shims. Listing '' is *correct on POSIX* (the only valid
 *   form there) and *fatal on Windows*; drop it from the Windows
 *   list entirely. The fake-claude smoke writes `.cmd` on Windows
 *   so this matches what the real binary install ships.
 */
function whichCommand(name) {
  const exts = process.platform === 'win32'
    ? ['.cmd', '.exe', '.bat']  // never '' on Windows — see comment above
    : [''];
  const sep = process.platform === 'win32' ? ';' : ':';
  const paths = (process.env.PATH || '').split(sep);
  for (const dir of paths) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return p;
      } catch (_e) { /* not here */ }
    }
  }
  return null;
}

/**
 * Build the stream-json input envelope for the initial prompt.
 * Claude CLI's `--input-format stream-json` expects newline-delimited
 * JSON messages with shape:
 *   { type: 'user', message: { role: 'user', content: [{ type:'text', text:'...' }] } }
 */
function makeInputEnvelope(prompt) {
  const envelope = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: String(prompt) }],
    },
  };
  return JSON.stringify(envelope) + '\n';
}

/**
 * @param {{ cwd: string, prompt: string, project_id?: string, iteration_id?: string, env?: Record<string,string|undefined> }} input
 * @param {{ home?: string, onLine?: (s:string)=>void, onEvent?: (e:any)=>void, idleTimeoutMs?: number }} [opts]
 * @returns {{ ok: boolean, run_id?: string, run?: object, error?: string }}
 */
function launchStreamWorker(input, opts) {
  const o = opts || {};
  if (!input || typeof input.cwd !== 'string' || !input.cwd) {
    return { ok: false, error: 'cwd_required' };
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    return { ok: false, error: 'prompt_required' };
  }
  if (!fs.existsSync(input.cwd)) {
    return { ok: false, error: 'cwd_not_found' };
  }

  const claudeExe = whichCommand('claude');
  if (!claudeExe) {
    return { ok: false, error: 'provider_unavailable', provider: SUPPORTED_PROVIDER };
  }

  const runId = newRunId();
  const home = o.home;
  ensureRunDir(runId, home);

  // Persist prompt for audit + debug.
  try {
    fs.writeFileSync(runFile(runId, 'prompt.txt', home), input.prompt.slice(0, 64 * 1024), 'utf8');
  } catch (_e) {
    return { ok: false, error: 'prompt_write_failed' };
  }

  // Phase 3: build per-spawn MCP config file. Read project .mcp.json,
  // override with canonical cairn-wedge entry, write to tmp. Failure
  // here is fatal — we want a loud failure rather than a CC spawn that
  // can't talk to cairn-wedge.
  const mcpRes = mcpConfigBuilder.buildMcpConfigFile({
    projectRoot: input.cwd,
    runId,
    tmpDir: o.mcpConfigTmpDir,
  });
  if (!mcpRes.ok) {
    cairnLog.error('claude-stream-launcher', 'mcp_config_failed', {
      run_id: runId,
      error: mcpRes.error,
    });
    return { ok: false, error: 'mcp_config_failed', detail: mcpRes.error };
  }

  const argv = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--mcp-config', mcpRes.tempPath,
    '--strict-mcp-config',
  ];

  // Phase 2: --resume <sessionId> if caller is continuing a prior run.
  // Validate non-empty string — silently dropping a bad value would
  // turn a resume into a fresh spawn and break the state machine.
  if (input.resumeSessionId != null) {
    if (typeof input.resumeSessionId !== 'string' || !input.resumeSessionId.trim()) {
      mcpRes.cleanup();
      return { ok: false, error: 'resumeSessionId_must_be_nonempty_string' };
    }
    argv.push('--resume', input.resumeSessionId);
  }

  // Per CLAUDE.md push section: spawn .cmd via cmd.exe on Windows.
  let exec = claudeExe;
  let execArgv = argv;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeExe)) {
    exec = process.env.ComSpec || 'cmd.exe';
    execArgv = ['/d', '/s', '/c', claudeExe, ...argv];
  }

  const meta = {
    run_id: runId,
    provider: SUPPORTED_PROVIDER,
    cwd: input.cwd,
    project_id: input.project_id || null,
    iteration_id: input.iteration_id || null,
    started_at: Date.now(),
    ended_at: null,
    status: 'queued',
    exit_code: null,
    pid: null,
    resolved_exe: claudeExe,
    argv,
    session_id: null,                            // populated from result event
    resume_session_id: input.resumeSessionId || null, // what we asked CC to resume
    mcp_config_path: mcpRes.tempPath,
    mcp_server_count: mcpRes.serverCount,
    last_event_at: null,
    event_count: 0,
  };
  writeRunMeta(runId, meta, home);

  let child;
  try {
    child = spawn(exec, execArgv, {
      cwd: input.cwd,
      env: o.env || input.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  } catch (e) {
    meta.status = 'failed';
    meta.ended_at = Date.now();
    meta.error = 'spawn_threw: ' + ((e && e.message) || String(e));
    writeRunMeta(runId, meta, home);
    mcpRes.cleanup();
    return { ok: false, error: 'spawn_threw', run_id: runId };
  }

  if (child.pid == null) {
    meta.status = 'failed';
    meta.ended_at = Date.now();
    meta.error = 'no_pid';
    writeRunMeta(runId, meta, home);
    mcpRes.cleanup();
    return { ok: false, error: 'no_pid', run_id: runId };
  }

  meta.status = 'running';
  meta.pid = child.pid;
  writeRunMeta(runId, meta, home);

  cairnLog.info('claude-stream-launcher', 'spawned', {
    run_id: runId,
    pid: child.pid,
    cwd: input.cwd,
    project_id: input.project_id || null,
  });

  // Write the initial prompt as one stream-json user-turn envelope.
  // IMPORTANT: do NOT call stdin.end() — the channel stays open so we
  // can write follow-up turns later (Phase 2+).
  try {
    child.stdin.write(makeInputEnvelope(input.prompt));
  } catch (e) {
    cairnLog.warn('claude-stream-launcher', 'stdin_write_failed', {
      run_id: runId,
      message: (e && e.message) || String(e),
    });
  }

  // Parse NDJSON from stdout.
  const parser = createNdjsonStream(child.stdout);
  let stdoutBuffer = ''; // For onLine callback (line-based, not event-based)

  const idleTimeoutMs = typeof o.idleTimeoutMs === 'number' ? o.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
  let watchdog = null;
  function bumpWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      cairnLog.warn('claude-stream-launcher', 'watchdog_idle_timeout', {
        run_id: runId,
        idle_ms: idleTimeoutMs,
      });
      try { child.kill('SIGTERM'); } catch (_e) { cairnLog.warn('claude-stream-launcher', 'watchdog_sigterm_failed', { message: (_e && _e.message) || String(_e) }); }
      // Force after grace period.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { cairnLog.warn('claude-stream-launcher', 'watchdog_sigkill_failed', { message: (_e && _e.message) || String(_e) }); } }, 5000).unref();
    }, idleTimeoutMs);
    if (watchdog.unref) watchdog.unref();
  }
  bumpWatchdog();

  parser.on('event', (ev) => {
    meta.event_count++;
    meta.last_event_at = Date.now();
    bumpWatchdog();

    // 1. Raw NDJSON line → stream_events.jsonl
    try {
      appendStreamEvent(runId, JSON.stringify(ev), home);
    } catch (_e) { cairnLog.warn('claude-stream-launcher', 'event_jsonl_write_failed', { message: (_e && _e.message) || String(_e) }); }

    // 2. Human-readable text → tail.log (backward compat with LLM helpers)
    const text = extractAssistantText(ev);
    if (text) {
      appendTail(runId, text, home);
      if (typeof o.onLine === 'function') {
        try { o.onLine(text); } catch (_e) { cairnLog.warn('claude-stream-launcher', 'onLine_callback_failed', { message: (_e && _e.message) || String(_e) }); }
      }
    }

    // 3. Capture session_id + result info from `result` events (Phase 2 prep)
    if (ev && ev.type === 'result') {
      if (typeof ev.session_id === 'string') meta.session_id = ev.session_id;
      if (typeof ev.subtype === 'string') meta.result_subtype = ev.subtype;
      if (ev.is_error === true) meta.result_is_error = true;
    }

    // 4. Caller hook (Phase 2 uses this to capture session_id immediately)
    if (typeof o.onEvent === 'function') {
      try { o.onEvent(ev); } catch (_e) { cairnLog.warn('claude-stream-launcher', 'onEvent_callback_failed', { message: (_e && _e.message) || String(_e) }); }
    }
  });

  parser.on('error', (err, raw) => {
    cairnLog.warn('claude-stream-launcher', 'ndjson_parse_error', {
      run_id: runId,
      message: (err && err.message) || String(err),
      raw_preview: raw ? String(raw).slice(0, 200) : null,
    });
  });

  // Capture stderr to tail.log too (for diagnostics, but typed so it
  // doesn't confuse downstream parsers as if it were a real CC turn).
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      try {
        const s = chunk.toString('utf8');
        appendTail(runId, '[stderr] ' + s, home);
      } catch (_e) { cairnLog.warn('claude-stream-launcher', 'stderr_append_failed', { message: (_e && _e.message) || String(_e) }); }
    });
  }

  child.on('error', (err) => {
    const m = readRunMeta(runId, home) || meta;
    m.status = 'failed';
    m.ended_at = Date.now();
    m.error = 'spawn_error: ' + ((err && err.message) || String(err));
    writeRunMeta(runId, m, home);
    // Defense-in-depth: 'error' usually precedes 'exit' so the exit
    // handler covers cleanup, but if an OS-level error skips 'exit'
    // the temp mcp-config file would leak until tmp GC. Idempotent.
    try { mcpRes.cleanup(); } catch (_e) { cairnLog.warn('claude-stream-launcher', 'mcp_config_cleanup_failed', { message: (_e && _e.message) || String(_e) }); }
    cairnLog.error('claude-stream-launcher', 'spawn_error', {
      run_id: runId,
      message: (err && err.message) || String(err),
    });
  });

  child.on('exit', (code, signal) => {
    if (watchdog) clearTimeout(watchdog);
    // Phase 3: drop the temp MCP config file. Safe to call even if it's
    // already gone (cleanup() swallows ENOENT).
    try { mcpRes.cleanup(); } catch (_e) { cairnLog.warn('claude-stream-launcher', 'mcp_config_exit_cleanup_failed', { message: (_e && _e.message) || String(_e) }); }
    // Source of truth for run-state-during-life is the in-memory `meta`
    // (event_count, last_event_at, session_id, result_subtype etc.
    // are mutated there as events flow). The disk-resident run.json
    // gets full snapshots at boot + on exit; intermediate reads (e.g.
    // panel polling) only see boot state for performance.
    meta.ended_at = Date.now();
    meta.exit_code = code;
    meta.signal = signal || null;
    if (code === 0) {
      meta.status = 'exited';
    } else {
      meta.status = 'failed';
      if (!meta.error) meta.error = signal ? 'signal:' + signal : 'exit_code:' + code;
    }
    writeRunMeta(runId, meta, home);
    cairnLog.info('claude-stream-launcher', 'exited', {
      run_id: runId,
      status: meta.status,
      exit_code: code,
      event_count: meta.event_count,
      session_id: meta.session_id,
    });
  });

  // Caller's stop() handle is not needed for Phase 1 — there's no
  // cancel path from mode-a-spawner. Worker dies naturally when CC
  // emits `result` + closes its stdout, or via watchdog kill.
  return {
    ok: true,
    run_id: runId,
    run: Object.assign({}, meta),
  };
}

/**
 * Read run.json by id. Mirrors worker-launcher.getWorkerRun signature
 * so mode-a-spawner can transparently check status without knowing
 * which launcher created the run.
 */
function getStreamRun(runId, opts) {
  return readRunMeta(runId, (opts || {}).home);
}

module.exports = {
  launchStreamWorker,
  getStreamRun,
  // Exposed for tests
  _whichCommand: whichCommand,
  _extractAssistantText: extractAssistantText,
  _makeInputEnvelope: makeInputEnvelope,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_TAIL_BYTES,
};
