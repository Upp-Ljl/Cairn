import { describe, it, expect } from 'vitest';
import {
  VALID_TRANSITIONS,
  assertTransition,
  type TaskState,
} from '../../src/storage/tasks-state.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const ALL_STATES: TaskState[] = [
  'PENDING', 'RUNNING', 'BLOCKED', 'READY_TO_RESUME',
  'WAITING_REVIEW', 'DONE', 'FAILED', 'CANCELLED',
];

const TERMINAL_STATES: TaskState[] = ['DONE', 'FAILED', 'CANCELLED'];

// ─── legal transitions — iterate the full spec table ────────────────────────

describe('VALID_TRANSITIONS table completeness', () => {
  it('has an entry for every TaskState', () => {
    for (const state of ALL_STATES) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
    }
  });

  it('PENDING can reach RUNNING', () => {
    expect(VALID_TRANSITIONS['PENDING'].has('RUNNING')).toBe(true);
  });

  it('PENDING can reach CANCELLED', () => {
    expect(VALID_TRANSITIONS['PENDING'].has('CANCELLED')).toBe(true);
  });

  it('RUNNING can reach BLOCKED', () => {
    expect(VALID_TRANSITIONS['RUNNING'].has('BLOCKED')).toBe(true);
  });

  it('RUNNING can reach WAITING_REVIEW', () => {
    expect(VALID_TRANSITIONS['RUNNING'].has('WAITING_REVIEW')).toBe(true);
  });

  it('RUNNING can reach FAILED', () => {
    expect(VALID_TRANSITIONS['RUNNING'].has('FAILED')).toBe(true);
  });

  it('RUNNING can reach CANCELLED', () => {
    expect(VALID_TRANSITIONS['RUNNING'].has('CANCELLED')).toBe(true);
  });

  it('BLOCKED can reach READY_TO_RESUME', () => {
    expect(VALID_TRANSITIONS['BLOCKED'].has('READY_TO_RESUME')).toBe(true);
  });

  it('BLOCKED can reach CANCELLED', () => {
    expect(VALID_TRANSITIONS['BLOCKED'].has('CANCELLED')).toBe(true);
  });

  it('READY_TO_RESUME can reach RUNNING', () => {
    expect(VALID_TRANSITIONS['READY_TO_RESUME'].has('RUNNING')).toBe(true);
  });

  it('WAITING_REVIEW can reach DONE', () => {
    expect(VALID_TRANSITIONS['WAITING_REVIEW'].has('DONE')).toBe(true);
  });

  it('WAITING_REVIEW can reach RUNNING (re-attempt after failed review)', () => {
    expect(VALID_TRANSITIONS['WAITING_REVIEW'].has('RUNNING')).toBe(true);
  });

  it('WAITING_REVIEW can reach FAILED', () => {
    expect(VALID_TRANSITIONS['WAITING_REVIEW'].has('FAILED')).toBe(true);
  });

  it('DONE is a terminal state — empty set', () => {
    expect(VALID_TRANSITIONS['DONE'].size).toBe(0);
  });

  it('FAILED is a terminal state — empty set', () => {
    expect(VALID_TRANSITIONS['FAILED'].size).toBe(0);
  });

  it('CANCELLED is a terminal state — empty set', () => {
    expect(VALID_TRANSITIONS['CANCELLED'].size).toBe(0);
  });
});

// ─── assertTransition — legal pairs all pass ────────────────────────────────

describe('assertTransition — legal transitions do not throw', () => {
  it('PENDING -> RUNNING', () => {
    expect(() => assertTransition('PENDING', 'RUNNING')).not.toThrow();
  });

  it('PENDING -> CANCELLED', () => {
    expect(() => assertTransition('PENDING', 'CANCELLED')).not.toThrow();
  });

  it('RUNNING -> BLOCKED', () => {
    expect(() => assertTransition('RUNNING', 'BLOCKED')).not.toThrow();
  });

  it('RUNNING -> WAITING_REVIEW', () => {
    expect(() => assertTransition('RUNNING', 'WAITING_REVIEW')).not.toThrow();
  });

  it('RUNNING -> FAILED', () => {
    expect(() => assertTransition('RUNNING', 'FAILED')).not.toThrow();
  });

  it('RUNNING -> CANCELLED', () => {
    expect(() => assertTransition('RUNNING', 'CANCELLED')).not.toThrow();
  });

  it('BLOCKED -> READY_TO_RESUME', () => {
    expect(() => assertTransition('BLOCKED', 'READY_TO_RESUME')).not.toThrow();
  });

  it('BLOCKED -> CANCELLED', () => {
    expect(() => assertTransition('BLOCKED', 'CANCELLED')).not.toThrow();
  });

  it('READY_TO_RESUME -> RUNNING', () => {
    expect(() => assertTransition('READY_TO_RESUME', 'RUNNING')).not.toThrow();
  });

  it('WAITING_REVIEW -> DONE', () => {
    expect(() => assertTransition('WAITING_REVIEW', 'DONE')).not.toThrow();
  });

  it('WAITING_REVIEW -> RUNNING', () => {
    expect(() => assertTransition('WAITING_REVIEW', 'RUNNING')).not.toThrow();
  });

  it('WAITING_REVIEW -> FAILED', () => {
    expect(() => assertTransition('WAITING_REVIEW', 'FAILED')).not.toThrow();
  });
});

// ─── assertTransition — illegal transitions throw ───────────────────────────

describe('assertTransition — illegal transitions throw', () => {
  // PENDING: cannot go to BLOCKED, READY_TO_RESUME, WAITING_REVIEW, DONE, FAILED, or itself
  it('PENDING -> BLOCKED is illegal', () => {
    expect(() => assertTransition('PENDING', 'BLOCKED')).toThrow();
  });

  it('PENDING -> DONE is illegal', () => {
    expect(() => assertTransition('PENDING', 'DONE')).toThrow();
  });

  it('PENDING -> PENDING (self-loop) is illegal', () => {
    expect(() => assertTransition('PENDING', 'PENDING')).toThrow();
  });

  // RUNNING: cannot go to PENDING, READY_TO_RESUME, DONE, or itself
  it('RUNNING -> PENDING is illegal', () => {
    expect(() => assertTransition('RUNNING', 'PENDING')).toThrow();
  });

  it('RUNNING -> READY_TO_RESUME is illegal', () => {
    expect(() => assertTransition('RUNNING', 'READY_TO_RESUME')).toThrow();
  });

  it('RUNNING -> RUNNING (self-loop) is illegal', () => {
    expect(() => assertTransition('RUNNING', 'RUNNING')).toThrow();
  });

  // BLOCKED: cannot go to PENDING, RUNNING, WAITING_REVIEW, DONE, FAILED
  it('BLOCKED -> PENDING is illegal', () => {
    expect(() => assertTransition('BLOCKED', 'PENDING')).toThrow();
  });

  it('BLOCKED -> RUNNING is illegal', () => {
    expect(() => assertTransition('BLOCKED', 'RUNNING')).toThrow();
  });

  it('BLOCKED -> DONE is illegal', () => {
    expect(() => assertTransition('BLOCKED', 'DONE')).toThrow();
  });

  // READY_TO_RESUME: can only go to RUNNING — everything else is illegal
  it('READY_TO_RESUME -> PENDING is illegal', () => {
    expect(() => assertTransition('READY_TO_RESUME', 'PENDING')).toThrow();
  });

  it('READY_TO_RESUME -> BLOCKED is illegal', () => {
    expect(() => assertTransition('READY_TO_RESUME', 'BLOCKED')).toThrow();
  });

  it('READY_TO_RESUME -> CANCELLED is illegal', () => {
    expect(() => assertTransition('READY_TO_RESUME', 'CANCELLED')).toThrow();
  });

  // WAITING_REVIEW: cannot go to PENDING, BLOCKED, READY_TO_RESUME, CANCELLED
  it('WAITING_REVIEW -> PENDING is illegal', () => {
    expect(() => assertTransition('WAITING_REVIEW', 'PENDING')).toThrow();
  });

  it('WAITING_REVIEW -> CANCELLED is illegal', () => {
    expect(() => assertTransition('WAITING_REVIEW', 'CANCELLED')).toThrow();
  });

  it('WAITING_REVIEW -> WAITING_REVIEW (self-loop) is illegal', () => {
    expect(() => assertTransition('WAITING_REVIEW', 'WAITING_REVIEW')).toThrow();
  });

  // Terminal states: DONE, FAILED, CANCELLED reject ALL transitions
  it('DONE -> RUNNING is illegal (terminal state)', () => {
    expect(() => assertTransition('DONE', 'RUNNING')).toThrow();
  });

  it('DONE -> PENDING is illegal (terminal state)', () => {
    expect(() => assertTransition('DONE', 'PENDING')).toThrow();
  });

  it('DONE -> DONE (self-loop) is illegal (terminal state)', () => {
    expect(() => assertTransition('DONE', 'DONE')).toThrow();
  });

  it('FAILED -> RUNNING is illegal (terminal state)', () => {
    expect(() => assertTransition('FAILED', 'RUNNING')).toThrow();
  });

  it('FAILED -> PENDING is illegal (terminal state)', () => {
    expect(() => assertTransition('FAILED', 'PENDING')).toThrow();
  });

  it('FAILED -> FAILED (self-loop) is illegal (terminal state)', () => {
    expect(() => assertTransition('FAILED', 'FAILED')).toThrow();
  });

  it('CANCELLED -> RUNNING is illegal (terminal state)', () => {
    expect(() => assertTransition('CANCELLED', 'RUNNING')).toThrow();
  });

  it('CANCELLED -> PENDING is illegal (terminal state)', () => {
    expect(() => assertTransition('CANCELLED', 'PENDING')).toThrow();
  });

  it('CANCELLED -> CANCELLED (self-loop) is illegal (terminal state)', () => {
    expect(() => assertTransition('CANCELLED', 'CANCELLED')).toThrow();
  });
});

// ─── error message observability ────────────────────────────────────────────

describe('assertTransition — error message mentions both from and to', () => {
  it('error from PENDING -> BLOCKED mentions PENDING and BLOCKED', () => {
    expect(() => assertTransition('PENDING', 'BLOCKED')).toThrow(/PENDING/);
    expect(() => assertTransition('PENDING', 'BLOCKED')).toThrow(/BLOCKED/);
  });

  it('error from DONE -> RUNNING mentions DONE and RUNNING', () => {
    expect(() => assertTransition('DONE', 'RUNNING')).toThrow(/DONE/);
    expect(() => assertTransition('DONE', 'RUNNING')).toThrow(/RUNNING/);
  });

  it('error from CANCELLED -> CANCELLED mentions CANCELLED', () => {
    expect(() => assertTransition('CANCELLED', 'CANCELLED')).toThrow(/CANCELLED/);
  });
});

// ─── exhaustive: terminal states reject every possible "to" state ───────────

describe('terminal states reject all possible target states', () => {
  for (const terminal of TERMINAL_STATES) {
    for (const to of ALL_STATES) {
      it(`${terminal} -> ${to} always throws`, () => {
        expect(() => assertTransition(terminal, to)).toThrow();
      });
    }
  }
});
