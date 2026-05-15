import { migration001Init } from './001-init.js';
import { migration002Scratchpad } from './002-scratchpad.js';
import { migration003Checkpoints } from './003-checkpoints.js';
import { migration004ProcessesConflicts } from './004-processes-conflicts.js';
import { migration005DispatchRequests } from './005-dispatch-requests.js';
import { migration006ConflictsPendingReview } from './006-conflicts-pending-review.js';
import { migration007Tasks } from './007-tasks.js';
import { migration008DispatchTaskId } from './008-dispatch-task-id.js';
import { migration009Blockers } from './009-blockers.js';
import { migration010Outcomes } from './010-outcomes.js';
import { migration011DispatchSource } from './011-dispatch-source.js';
import type { Migration } from './runner.js';

export const ALL_MIGRATIONS: Migration[] = [
  migration001Init,
  migration002Scratchpad,
  migration003Checkpoints,
  migration004ProcessesConflicts,
  migration005DispatchRequests,
  migration006ConflictsPendingReview,
  migration007Tasks,
  migration008DispatchTaskId,
  migration009Blockers,
  migration010Outcomes,
  migration011DispatchSource,
];
