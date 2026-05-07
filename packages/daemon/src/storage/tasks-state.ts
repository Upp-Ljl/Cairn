export type TaskState = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'READY_TO_RESUME'
                      | 'WAITING_REVIEW' | 'DONE' | 'FAILED' | 'CANCELLED';

export const VALID_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  PENDING:         new Set(['RUNNING', 'CANCELLED']),
  RUNNING:         new Set(['BLOCKED', 'WAITING_REVIEW', 'FAILED', 'CANCELLED']),
  BLOCKED:         new Set(['READY_TO_RESUME', 'CANCELLED']),
  READY_TO_RESUME: new Set(['RUNNING']),
  WAITING_REVIEW:  new Set(['DONE', 'RUNNING', 'FAILED']),
  DONE:            new Set(),
  FAILED:          new Set(),
  CANCELLED:       new Set(),
};

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!VALID_TRANSITIONS[from].has(to)) {
    throw new Error(`Invalid task state transition: ${from} -> ${to}`);
  }
}
