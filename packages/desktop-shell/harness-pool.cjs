'use strict';

/**
 * harness-pool.cjs — Agent Pool / Session Lifecycle Manager (Module 8).
 *
 * Manages typed agent slots (WORKER / REVIEWER) with spawn, reuse, and
 * teardown. Does NOT directly import child_process or claude-stream-launcher.
 * All child spawning is delegated to the injected `launcherFn`.
 *
 * API:
 *   const { createPool, SLOT_STATES, SLOT_TYPES } = require('./harness-pool.cjs');
 *   const pool = createPool({ project, plan, launcherFn, buildPromptFn, opts });
 *   pool.getWorker(stepIdx)  -> slotHandle
 *   pool.getReviewer()       -> slotHandle
 *   await pool.teardown()
 *   pool.getState()          -> { worker, reviewer, planId }
 *
 * slotHandle:
 *   { child, agentId, writeNextTurn(prompt), isAlive(), stepCount, slotState }
 *
 * Slot state machine:
 *   EMPTY -> SPAWNING -> READY -> BUSY -> READY -> ... -> TEARDOWN -> EMPTY
 *                                   |
 *                                   +-> DEAD (crash/exit) -> EMPTY (re-spawn)
 */

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SLOT_STATES = Object.freeze({
  EMPTY: 'EMPTY',
  SPAWNING: 'SPAWNING',
  READY: 'READY',
  BUSY: 'BUSY',
  DEAD: 'DEAD',
  TEARDOWN: 'TEARDOWN',
});

const SLOT_TYPES = Object.freeze({
  WORKER: 'WORKER',
  REVIEWER: 'REVIEWER',
});

const DEFAULT_MAX_STEPS_BEFORE_RESTART = 5;
const DEFAULT_GRACE_PERIOD_MS = 30000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateAgentId(slotType) {
  const hex = crypto.randomBytes(6).toString('hex');
  if (slotType === SLOT_TYPES.REVIEWER) {
    return `cairn-reviewer-${hex}`;
  }
  return `cairn-worker-${hex}`;
}

/**
 * Build the stream-json input envelope for a new user turn.
 * Format: {"type":"user","message":{"role":"user","content":"<prompt>"}}\n
 */
function makeInputEnvelope(prompt) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: prompt },
  }) + '\n';
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

/**
 * createSlot — internal slot object.
 *
 * Holds all mutable state for one typed agent slot.
 */
function createSlot(slotType) {
  return {
    type: slotType,
    agentId: null,
    child: null,
    runResult: null, // { ok, run_id, agent_id, ... } returned by launcherFn
    slotState: SLOT_STATES.EMPTY,
    stepCount: 0,
  };
}

/**
 * spawnSlot — call launcherFn, wire exit listener, transition state.
 *
 * @param {object} slot        - mutable slot reference (updated in-place)
 * @param {function} launcherFn - injected launcher
 * @param {object} launchOpts  - passed through to launcherFn
 * @param {function} onExit    - called when child exits unexpectedly
 * @returns {object} the slot handle
 */
function spawnSlot(slot, launcherFn, launchOpts, onExit) {
  slot.slotState = SLOT_STATES.SPAWNING;
  slot.agentId = generateAgentId(slot.type);
  slot.stepCount = 0;

  const result = launcherFn({ ...launchOpts, agentId: slot.agentId });
  slot.runResult = result;
  slot.child = result.child;

  // Wire exit listener for crash detection.
  if (slot.child && typeof slot.child.on === 'function') {
    slot.child.once('exit', (code, signal) => {
      // Only flag as DEAD if not already in TEARDOWN.
      if (slot.slotState !== SLOT_STATES.TEARDOWN && slot.slotState !== SLOT_STATES.EMPTY) {
        slot.slotState = SLOT_STATES.DEAD;
        if (typeof onExit === 'function') {
          onExit({ slotType: slot.type, agentId: slot.agentId, code, signal });
        }
      }
    });
  }

  slot.slotState = SLOT_STATES.READY;
  return slot;
}

/**
 * buildSlotHandle — public-facing handle returned to callers.
 */
function buildSlotHandle(slot) {
  return {
    get child() { return slot.child; },
    get agentId() { return slot.agentId; },
    get slotState() { return slot.slotState; },
    get stepCount() { return slot.stepCount; },
    isAlive() {
      if (!slot.child) return false;
      if (slot.slotState === SLOT_STATES.DEAD || slot.slotState === SLOT_STATES.EMPTY || slot.slotState === SLOT_STATES.TEARDOWN) return false;
      // Check if child has exited.
      if (slot.child.killed) return false;
      if (typeof slot.child.exitCode === 'number') return false;
      return true;
    },
    writeNextTurn(prompt) {
      if (!slot.child || !slot.child.stdin) {
        throw new Error(`harness-pool: slot ${slot.type} has no stdin to write to`);
      }
      const envelope = makeInputEnvelope(prompt);
      slot.child.stdin.write(envelope);
    },
  };
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * createPool — factory for the agent pool.
 *
 * @param {object} params
 * @param {object} params.project         - { id, project_root, ... }
 * @param {object} params.plan            - { plan_id, steps, ... }
 * @param {function} params.launcherFn    - function(opts) returning { ok, child, run_id, agent_id }
 * @param {function} params.buildPromptFn - function(step) returning boot prompt string (optional)
 * @param {object} params.opts
 * @param {number}  params.opts.maxStepsBeforeRestart - default 5
 * @param {number}  params.opts.gracePeriodMs         - default 30000
 * @param {function} params.opts.nowFn               - injectable clock, default Date.now
 * @returns {object} pool
 */
function createPool({ project, plan, launcherFn, buildPromptFn, opts = {} }) {
  if (typeof launcherFn !== 'function') {
    throw new TypeError('harness-pool: launcherFn must be a function');
  }

  const maxStepsBeforeRestart = opts.maxStepsBeforeRestart ?? DEFAULT_MAX_STEPS_BEFORE_RESTART;
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();

  const planId = plan && plan.plan_id ? plan.plan_id : null;

  // One slot per type.
  const workerSlot = createSlot(SLOT_TYPES.WORKER);
  const reviewerSlot = createSlot(SLOT_TYPES.REVIEWER);

  function buildLaunchOpts(slot, extraOpts) {
    return {
      project_id: project && project.id ? project.id : 'unknown',
      project_root: project && project.project_root ? project.project_root : process.cwd(),
      plan_id: planId,
      agentId: slot.agentId, // will be overwritten by spawnSlot
      agent_type: slot.type.toLowerCase(),
      ...extraOpts,
    };
  }

  function onSlotExit(info) {
    // Called when a slot child exits unexpectedly — slot already marked DEAD.
    // No re-spawn here: re-spawn happens lazily on next getWorker()/getReviewer().
  }

  // ---------------------------------------------------------------------------
  // getWorker
  // ---------------------------------------------------------------------------

  /**
   * getWorker(stepIdx) — get or create the WORKER slot.
   *
   * Reuse policy:
   *   - If existing child is alive AND stepCount < maxStepsBeforeRestart → reuse,
   *     increment stepCount.
   *   - If stepCount >= maxStepsBeforeRestart → teardown current, spawn fresh.
   *   - If child is DEAD or EMPTY → spawn fresh.
   *
   * @param {number} stepIdx - current step index (used for restart logic)
   * @returns {object} slotHandle
   */
  function getWorker(stepIdx) {
    const handle = buildSlotHandle(workerSlot);

    const alive = handle.isAlive();
    const needsRestart = alive && workerSlot.stepCount >= maxStepsBeforeRestart;

    if (needsRestart) {
      // Graceful teardown of current worker before spawning fresh.
      _teardownSlot(workerSlot, 0); // no grace for restart — immediate
    }

    if (!alive || needsRestart) {
      // Spawn fresh worker.
      const launchOpts = buildLaunchOpts(workerSlot, {});
      spawnSlot(workerSlot, launcherFn, launchOpts, onSlotExit);
    }

    // Increment step count for this usage.
    workerSlot.stepCount++;
    workerSlot.slotState = SLOT_STATES.READY;

    return buildSlotHandle(workerSlot);
  }

  // ---------------------------------------------------------------------------
  // getReviewer
  // ---------------------------------------------------------------------------

  /**
   * getReviewer() — get or create the REVIEWER slot.
   *
   * Reviewer is reused across reviews in the same plan; no step-count limit.
   * Each review is a short turn, so context doesn't degrade.
   *
   * @returns {object} slotHandle
   */
  function getReviewer() {
    const handle = buildSlotHandle(reviewerSlot);
    const alive = handle.isAlive();

    if (!alive) {
      const launchOpts = buildLaunchOpts(reviewerSlot, { agent_type: 'reviewer' });
      spawnSlot(reviewerSlot, launcherFn, launchOpts, onSlotExit);
    }

    reviewerSlot.slotState = SLOT_STATES.READY;
    return buildSlotHandle(reviewerSlot);
  }

  // ---------------------------------------------------------------------------
  // teardown (internal helper for one slot)
  // ---------------------------------------------------------------------------

  function _teardownSlot(slot, gracePeriod) {
    if (slot.slotState === SLOT_STATES.EMPTY) return Promise.resolve();

    slot.slotState = SLOT_STATES.TEARDOWN;

    return new Promise((resolve) => {
      if (!slot.child || !buildSlotHandle(slot).isAlive()) {
        slot.slotState = SLOT_STATES.EMPTY;
        slot.child = null;
        resolve();
        return;
      }

      // Write graceful shutdown message.
      try {
        if (slot.child.stdin && !slot.child.stdin.destroyed) {
          const shutdownEnvelope = makeInputEnvelope(
            'Harness shutdown: save your current state and exit gracefully.'
          );
          slot.child.stdin.write(shutdownEnvelope);
        }
      } catch (_) {
        // stdin may already be closed; ignore.
      }

      if (gracePeriod <= 0) {
        // Immediate kill (used for auto-restart).
        try { slot.child.kill('SIGTERM'); } catch (_) {}
        slot.slotState = SLOT_STATES.EMPTY;
        slot.child = null;
        resolve();
        return;
      }

      // Wait gracePeriodMs, then SIGTERM if still alive.
      const timer = setTimeout(() => {
        try {
          if (slot.child && !slot.child.killed) {
            slot.child.kill('SIGTERM');
          }
        } catch (_) {}
        slot.slotState = SLOT_STATES.EMPTY;
        slot.child = null;
        resolve();
      }, gracePeriod);

      // If child exits early, clear the timer.
      if (slot.child) {
        slot.child.once('exit', () => {
          clearTimeout(timer);
          slot.slotState = SLOT_STATES.EMPTY;
          slot.child = null;
          resolve();
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // teardown (public — all slots)
  // ---------------------------------------------------------------------------

  /**
   * teardown() — graceful shutdown of all slots.
   *
   * For each alive slot:
   *   1. Write shutdown message to stdin.
   *   2. Wait gracePeriodMs.
   *   3. SIGTERM any remaining.
   *
   * @returns {Promise<void>}
   */
  async function teardown() {
    await Promise.all([
      _teardownSlot(workerSlot, gracePeriodMs),
      _teardownSlot(reviewerSlot, gracePeriodMs),
    ]);
  }

  // ---------------------------------------------------------------------------
  // getState
  // ---------------------------------------------------------------------------

  /**
   * getState() — snapshot for debugging / dashboard.
   *
   * @returns {{ worker: object, reviewer: object, planId: string|null }}
   */
  function getState() {
    return {
      planId,
      worker: {
        agentId: workerSlot.agentId,
        slotState: workerSlot.slotState,
        stepCount: workerSlot.stepCount,
      },
      reviewer: {
        agentId: reviewerSlot.agentId,
        slotState: reviewerSlot.slotState,
        stepCount: reviewerSlot.stepCount,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    getWorker,
    getReviewer,
    teardown,
    getState,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createPool, SLOT_STATES, SLOT_TYPES };
