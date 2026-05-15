'use strict';
/**
 * harness-budget.cjs — Budget Controller for Mode A step execution.
 *
 * Pure state machine: no fs, no child_process, no cairn-log, no side effects.
 * Caller is responsible for logging and writing messages to child.stdin.
 *
 * Budget lifecycle per step:
 *   GREEN (init) -> YELLOW (75%) -> RED (90%) -> FUSE (100%)
 *
 * Budget dimensions:
 *   - max_duration_ms:    default 600000 (10 min)
 *   - max_tool_calls:     default 80
 *   - max_output_tokens:  default 50000 (estimated from content length)
 *
 * Zone transitions:
 *   GREEN  -> YELLOW:  no action (caller should log)
 *   YELLOW -> RED:     action='wrap_up'  returned once
 *   RED    -> FUSE:    action='fuse'     returned once
 *   FUSE stays FUSE; subsequent check() returns action=null
 */

const ZONES = Object.freeze({
  GREEN:  'GREEN',
  YELLOW: 'YELLOW',
  RED:    'RED',
  FUSE:   'FUSE',
});

const DEFAULT_LIMITS = Object.freeze({
  max_duration_ms:   600000, // 10 minutes
  max_tool_calls:    80,
  max_output_tokens: 50000,
});

// Zone thresholds (fraction of limit)
const THRESHOLDS = Object.freeze({
  YELLOW: 0.75,
  RED:    0.90,
  FUSE:   1.00,
});

/**
 * Estimate token count from a text string.
 * Rough approximation: word count * 1.3 (accounts for punctuation, whitespace tokens).
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(wordCount * 1.3);
}

/**
 * Extract text content from an assistant event.
 * Handles both direct content arrays and nested message structures.
 *
 * @param {object} event
 * @returns {string}
 */
function extractAssistantText(event) {
  const parts = [];

  // event.message.content array (stream-json assistant event shape)
  const content = event.message && event.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }

  // Fallback: top-level content string
  if (parts.length === 0 && typeof event.content === 'string') {
    parts.push(event.content);
  }

  return parts.join(' ');
}

/**
 * Determine if an event includes a tool_use block.
 *
 * @param {object} event
 * @returns {boolean}
 */
function eventHasToolUse(event) {
  if (event.type === 'tool_use') return true;

  const content = event.message && event.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'tool_use') return true;
    }
  }

  // top-level content array (alternate shape)
  if (Array.isArray(event.content)) {
    for (const block of event.content) {
      if (block && block.type === 'tool_use') return true;
    }
  }

  return false;
}

/**
 * Map a percentage (0..1) to a zone.
 *
 * @param {number} pct
 * @returns {string}
 */
function pctToZone(pct) {
  if (pct >= THRESHOLDS.FUSE)   return ZONES.FUSE;
  if (pct >= THRESHOLDS.RED)    return ZONES.RED;
  if (pct >= THRESHOLDS.YELLOW) return ZONES.YELLOW;
  return ZONES.GREEN;
}

/**
 * Given old zone and new zone, return the action emitted on first entry to new zone.
 * Returns null if zone didn't change or new zone doesn't emit an action.
 *
 * @param {string} oldZone
 * @param {string} newZone
 * @returns {string|null}
 */
function transitionAction(oldZone, newZone) {
  if (oldZone === newZone) return null;
  if (newZone === ZONES.RED)  return 'wrap_up';
  if (newZone === ZONES.FUSE) return 'fuse';
  return null;
}

/**
 * Create a budget controller for a single plan step.
 *
 * @param {object} [limits]  — optional overrides for DEFAULT_LIMITS fields
 * @param {object} [opts]    — optional injection points
 * @param {function} [opts.nowFn]  — injectable clock for testing (default: Date.now)
 * @returns {{ check, getMetrics, reset, wrapUpMessage, fuseMessage }}
 */
function createBudget(limits, opts) {
  const _nowFn = (opts && typeof opts.nowFn === 'function') ? opts.nowFn : Date.now;

  let _limits = Object.assign({}, DEFAULT_LIMITS, limits || {});
  let _startTime = _nowFn();
  let _zone = ZONES.GREEN;
  let _tool_calls = 0;
  let _estimated_tokens = 0;

  /**
   * Compute current metrics snapshot.
   * @returns {object}
   */
  function _snapshot() {
    const now = _nowFn();
    const elapsed_ms = now - _startTime;

    const pct_duration = _limits.max_duration_ms > 0
      ? elapsed_ms / _limits.max_duration_ms
      : 0;
    const pct_tools = _limits.max_tool_calls > 0
      ? _tool_calls / _limits.max_tool_calls
      : 0;
    const pct_tokens = _limits.max_output_tokens > 0
      ? _estimated_tokens / _limits.max_output_tokens
      : 0;

    const overallPct = Math.max(pct_duration, pct_tools, pct_tokens);
    const computedZone = pctToZone(overallPct);

    // Zone is one-way: can only advance forward
    const zoneOrder = [ZONES.GREEN, ZONES.YELLOW, ZONES.RED, ZONES.FUSE];
    const currentIdx = zoneOrder.indexOf(_zone);
    const computedIdx = zoneOrder.indexOf(computedZone);
    const newZone = computedIdx > currentIdx ? computedZone : _zone;

    return {
      newZone,
      elapsed_ms,
      pct_duration: Math.min(pct_duration, 1),
      pct_tools:    Math.min(pct_tools,    1),
      pct_tokens:   Math.min(pct_tokens,   1),
    };
  }

  /**
   * Process a stream event. Updates internal counters and returns zone+action.
   *
   * @param {object} event  — NDJSON event from claude-stream-launcher
   * @returns {{ zone: string, action: string|null, metrics: object }}
   */
  function check(event) {
    if (event && typeof event === 'object') {
      // Count assistant output tokens
      if (event.type === 'assistant') {
        const text = extractAssistantText(event);
        _estimated_tokens += estimateTokens(text);
      }

      // Count tool calls
      if (eventHasToolUse(event)) {
        _tool_calls += 1;
      }
    }

    const snap = _snapshot();
    const oldZone = _zone;
    const action = transitionAction(oldZone, snap.newZone);
    _zone = snap.newZone;

    return {
      zone: _zone,
      action,
      metrics: {
        zone:             _zone,
        elapsed_ms:       snap.elapsed_ms,
        tool_calls:       _tool_calls,
        estimated_tokens: _estimated_tokens,
        pct_duration:     snap.pct_duration,
        pct_tools:        snap.pct_tools,
        pct_tokens:       snap.pct_tokens,
      },
    };
  }

  /**
   * Return current metrics without processing an event.
   * @returns {object}
   */
  function getMetrics() {
    const snap = _snapshot();
    return {
      zone:             _zone,
      elapsed_ms:       snap.elapsed_ms,
      tool_calls:       _tool_calls,
      estimated_tokens: _estimated_tokens,
      pct_duration:     snap.pct_duration,
      pct_tools:        snap.pct_tools,
      pct_tokens:       snap.pct_tokens,
    };
  }

  /**
   * Reset all counters and optionally update limits. Zone goes back to GREEN.
   * Use when pool reuses a worker for the next step.
   *
   * @param {object} [newLimits]  — optional new limits (merged with DEFAULT_LIMITS)
   */
  function reset(newLimits) {
    _limits = Object.assign({}, DEFAULT_LIMITS, newLimits || {});
    _startTime = _nowFn();
    _zone = ZONES.GREEN;
    _tool_calls = 0;
    _estimated_tokens = 0;
  }

  /**
   * The wrap-up message to write to child.stdin when zone transitions to RED.
   * @returns {string}
   */
  function wrapUpMessage() {
    return (
      'You are at 90% of your execution budget. ' +
      'Please finish the current task immediately, commit any changes, ' +
      'and call cairn.task.submit_for_review or cairn.task.block to record progress. ' +
      'Do not start new work.'
    );
  }

  /**
   * The fuse message to write to child.stdin when zone transitions to FUSE.
   * @returns {string}
   */
  function fuseMessage() {
    return (
      'Budget exhausted. Save state NOW. ' +
      'If the current task is incomplete, call cairn.task.block with a clear description ' +
      'of what remains. Do not attempt further work — the harness will terminate this session.'
    );
  }

  return { check, getMetrics, reset, wrapUpMessage, fuseMessage };
}

module.exports = { createBudget, DEFAULT_LIMITS, ZONES };
