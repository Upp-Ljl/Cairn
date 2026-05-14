'use strict';

/**
 * ndjson-stream.cjs — newline-delimited JSON parser for child stdout.
 *
 * Subagent verdict 2026-05-14: Cairn's Mode A spawn was using
 * `claude --print` (one-shot, output buffered until exit). Switching to
 * `claude --output-format stream-json` requires parsing a continuous
 * NDJSON stream where each line is one JSON event.
 *
 * Design (mirrors Agora's local/src/runner/ndjson.ts):
 *   - line-buffer across chunked stdin reads (chunk boundaries do not
 *     align with line boundaries — especially on Windows where pipes
 *     can deliver mid-line bytes)
 *   - 1 MiB per-line cap; oversize lines are skipped + reported via
 *     'error' event (we don't abort the whole session for one bad line)
 *   - emits 'event' for each parsed object; 'error' for parse failures;
 *     'end' when the upstream stream ends
 *
 * Usage:
 *   const { createNdjsonStream } = require('./ndjson-stream.cjs');
 *   const parser = createNdjsonStream(child.stdout);
 *   parser.on('event', (obj) => { ... });
 *   parser.on('error', (e, raw) => { ... });
 *   parser.on('end', () => { ... });
 */

const { EventEmitter } = require('node:events');

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024; // 1 MiB
const NEWLINE = 0x0a; // '\n'

/**
 * @param {NodeJS.ReadableStream} readable
 * @param {{ maxLineBytes?: number }} [opts]
 * @returns {EventEmitter}
 */
function createNdjsonStream(readable, opts) {
  const o = opts || {};
  const maxLineBytes = typeof o.maxLineBytes === 'number' && o.maxLineBytes > 0
    ? o.maxLineBytes
    : DEFAULT_MAX_LINE_BYTES;
  const ee = new EventEmitter();

  /** @type {Buffer[]} accumulator for the current in-progress line */
  let pending = [];
  let pendingLen = 0;
  let overflowing = false;
  let endedEmitted = false;

  function flushLine(buf) {
    // buf is a complete line (no trailing newline). Skip empty lines.
    if (buf.length === 0) return;
    if (buf.length > maxLineBytes) {
      ee.emit('error', new Error('ndjson_line_too_large:' + buf.length), null);
      return;
    }
    let s = buf.toString('utf8');
    // Strip CR if present (Windows line endings)
    if (s.endsWith('\r')) s = s.slice(0, -1);
    if (s.length === 0) return;
    let parsed;
    try { parsed = JSON.parse(s); }
    catch (e) {
      ee.emit('error', e, s);
      return;
    }
    ee.emit('event', parsed);
  }

  function onData(chunk) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === NEWLINE) {
        if (overflowing) {
          // We were dropping bytes mid-line because of overflow.
          // The newline resets state; start a fresh line at i+1.
          pending = [];
          pendingLen = 0;
          overflowing = false;
          start = i + 1;
          continue;
        }
        // Emit the line: pending + chunk[start..i]
        let line;
        if (pending.length === 0) {
          line = chunk.slice(start, i);
        } else {
          pending.push(chunk.slice(start, i));
          line = Buffer.concat(pending);
        }
        pending = [];
        pendingLen = 0;
        flushLine(line);
        start = i + 1;
      }
    }
    // Remainder (no trailing newline) → pending
    if (start < chunk.length) {
      const remainder = chunk.slice(start);
      pendingLen += remainder.length;
      if (pendingLen > maxLineBytes) {
        // Drop further bytes until the next newline; signal overflow.
        if (!overflowing) {
          ee.emit('error', new Error('ndjson_line_too_large:pending=' + pendingLen), null);
          overflowing = true;
          pending = [];
          pendingLen = 0;
        }
      } else {
        pending.push(remainder);
      }
    }
  }

  function onEnd() {
    // Flush any pending bytes as a final line (without a trailing newline).
    if (pending.length > 0 && !overflowing) {
      flushLine(Buffer.concat(pending));
    }
    pending = [];
    pendingLen = 0;
    overflowing = false;
    if (!endedEmitted) {
      endedEmitted = true;
      ee.emit('end');
    }
  }

  function onError(err) {
    ee.emit('error', err, null);
  }

  readable.on('data', onData);
  readable.on('end', onEnd);
  readable.on('error', onError);
  readable.on('close', onEnd); // fallback for streams that don't emit 'end'

  return ee;
}

module.exports = {
  createNdjsonStream,
  DEFAULT_MAX_LINE_BYTES,
};
