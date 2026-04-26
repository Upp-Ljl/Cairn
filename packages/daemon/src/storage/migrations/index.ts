import { migration001Init } from './001-init.js';
import type { Migration } from './runner.js';

export const ALL_MIGRATIONS: Migration[] = [migration001Init];
