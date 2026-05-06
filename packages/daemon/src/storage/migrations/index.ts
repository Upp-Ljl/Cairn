import { migration001Init } from './001-init.js';
import { migration002Scratchpad } from './002-scratchpad.js';
import { migration003Checkpoints } from './003-checkpoints.js';
import { migration004ProcessesConflicts } from './004-processes-conflicts.js';
import { migration005DispatchRequests } from './005-dispatch-requests.js';
import type { Migration } from './runner.js';

export const ALL_MIGRATIONS: Migration[] = [
  migration001Init,
  migration002Scratchpad,
  migration003Checkpoints,
  migration004ProcessesConflicts,
  migration005DispatchRequests,
];
