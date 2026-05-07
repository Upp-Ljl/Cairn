import type { OutcomePrimitive, PrimitiveName } from './types.js';

const PRIMITIVE_NAMES = new Set<string>([
  'tests_pass',
  'command_exits_0',
  'file_exists',
  'regex_matches',
  'scratchpad_key_exists',
  'no_open_conflicts',
  'checkpoint_created_after',
]);

// Keys allowed in args per primitive (required + optional)
const ALLOWED_ARGS_KEYS: Record<PrimitiveName, Set<string>> = {
  tests_pass:               new Set(['target']),
  command_exits_0:          new Set(['cmd', 'cwd']),
  file_exists:              new Set(['path']),
  regex_matches:            new Set(['file', 'pattern', 'flags']),
  scratchpad_key_exists:    new Set(['key', 'task_id']),
  no_open_conflicts:        new Set(['scope_paths']),
  checkpoint_created_after: new Set(['timestamp', 'task_id']),
};

// Required (non-optional) args keys per primitive
const REQUIRED_ARGS_KEYS: Record<PrimitiveName, string[]> = {
  tests_pass:               [],
  command_exits_0:          ['cmd'],
  file_exists:              ['path'],
  regex_matches:            ['file', 'pattern'],
  scratchpad_key_exists:    ['key'],
  no_open_conflicts:        [],
  checkpoint_created_after: ['timestamp'],
};

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateStringField(
  obj: Record<string, unknown>,
  key: string,
  required: boolean,
  errors: string[],
  prefix: string,
): void {
  if (!(key in obj)) {
    if (required) errors.push(`${prefix}: missing required args.${key}`);
    return;
  }
  const val = obj[key];
  if (val !== undefined && typeof val !== 'string') {
    errors.push(`${prefix}: args.${key} must be a string`);
  }
}

function validateElement(
  elem: unknown,
  idx: number,
  errors: string[],
): OutcomePrimitive | null {
  if (!isNonNullObject(elem)) {
    errors.push(`NOT_AN_OBJECT_AT_INDEX_${idx}`);
    return null;
  }

  // Check for extra top-level keys beyond {primitive, args}
  const topKeys = Object.keys(elem).filter(k => k !== 'primitive' && k !== 'args');
  if (topKeys.length > 0) {
    errors.push(`UNEXPECTED_KEYS_AT_INDEX_${idx}: [${topKeys.join(', ')}]`);
  }

  // Validate primitive field
  if (!('primitive' in elem) || typeof elem['primitive'] !== 'string') {
    errors.push(`MISSING_OR_INVALID_PRIMITIVE_AT_INDEX_${idx}`);
    return null;
  }
  const primitive = elem['primitive'] as string;
  if (!PRIMITIVE_NAMES.has(primitive)) {
    errors.push(`UNKNOWN_PRIMITIVE_AT_INDEX_${idx}: ${primitive}`);
    return null;
  }
  const pName = primitive as PrimitiveName;

  // Validate args field
  if (!('args' in elem) || !isNonNullObject(elem['args'])) {
    errors.push(`MISSING_OR_INVALID_ARGS_AT_INDEX_${idx}`);
    return null;
  }
  const args = elem['args'] as Record<string, unknown>;

  // Check for extra args keys
  const allowedKeys = ALLOWED_ARGS_KEYS[pName];
  const extraArgsKeys = Object.keys(args).filter(k => !allowedKeys.has(k));
  if (extraArgsKeys.length > 0) {
    errors.push(`UNEXPECTED_ARGS_KEYS_${pName}_AT_INDEX_${idx}: [${extraArgsKeys.join(', ')}]`);
  }

  // Check required args keys exist
  for (const reqKey of REQUIRED_ARGS_KEYS[pName]) {
    if (!(reqKey in args)) {
      errors.push(`MISSING_REQUIRED_ARG_${pName}.${reqKey}_AT_INDEX_${idx}`);
    }
  }

  // Type-check each arg field per primitive
  const typePrefix = `WRONG_TYPE`;
  switch (pName) {
    case 'tests_pass':
      if ('target' in args && args['target'] !== undefined && typeof args['target'] !== 'string') {
        errors.push(`${typePrefix}_tests_pass.target_AT_INDEX_${idx}`);
      }
      break;

    case 'command_exits_0':
      if ('cmd' in args && typeof args['cmd'] !== 'string') {
        errors.push(`${typePrefix}_command_exits_0.cmd_AT_INDEX_${idx}`);
      }
      if ('cwd' in args && args['cwd'] !== undefined && typeof args['cwd'] !== 'string') {
        errors.push(`${typePrefix}_command_exits_0.cwd_AT_INDEX_${idx}`);
      }
      break;

    case 'file_exists':
      if ('path' in args && typeof args['path'] !== 'string') {
        errors.push(`${typePrefix}_file_exists.path_AT_INDEX_${idx}`);
      }
      break;

    case 'regex_matches':
      if ('file' in args && typeof args['file'] !== 'string') {
        errors.push(`${typePrefix}_regex_matches.file_AT_INDEX_${idx}`);
      }
      if ('pattern' in args && typeof args['pattern'] !== 'string') {
        errors.push(`${typePrefix}_regex_matches.pattern_AT_INDEX_${idx}`);
      }
      if ('flags' in args && args['flags'] !== undefined && typeof args['flags'] !== 'string') {
        errors.push(`${typePrefix}_regex_matches.flags_AT_INDEX_${idx}`);
      }
      break;

    case 'scratchpad_key_exists':
      if ('key' in args && typeof args['key'] !== 'string') {
        errors.push(`${typePrefix}_scratchpad_key_exists.key_AT_INDEX_${idx}`);
      }
      if ('task_id' in args && args['task_id'] !== undefined && typeof args['task_id'] !== 'string') {
        errors.push(`${typePrefix}_scratchpad_key_exists.task_id_AT_INDEX_${idx}`);
      }
      break;

    case 'no_open_conflicts':
      if ('scope_paths' in args && args['scope_paths'] !== undefined) {
        if (!Array.isArray(args['scope_paths'])) {
          errors.push(`${typePrefix}_no_open_conflicts.scope_paths_AT_INDEX_${idx}`);
        } else {
          const arr = args['scope_paths'] as unknown[];
          for (let j = 0; j < arr.length; j++) {
            if (typeof arr[j] !== 'string') {
              errors.push(`${typePrefix}_no_open_conflicts.scope_paths[${j}]_AT_INDEX_${idx}`);
            }
          }
        }
      }
      break;

    case 'checkpoint_created_after':
      if ('timestamp' in args && typeof args['timestamp'] !== 'number') {
        errors.push(`${typePrefix}_checkpoint_created_after.timestamp_AT_INDEX_${idx}`);
      }
      if ('task_id' in args && args['task_id'] !== undefined && typeof args['task_id'] !== 'string') {
        errors.push(`${typePrefix}_checkpoint_created_after.task_id_AT_INDEX_${idx}`);
      }
      break;
  }

  // Only return a typed value if no errors were added for this element
  // (caller collects all errors; we return null to signal partial failure)
  if (errors.length > 0) return null;
  return elem as unknown as OutcomePrimitive;
}

export function parseCriteriaJSON(
  raw: unknown,
): { ok: true; criteria: OutcomePrimitive[] } | { ok: false; errors: string[] } {
  let parsed: unknown = raw;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, errors: [`INVALID_JSON: ${msg}`] };
    }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, errors: ['NOT_AN_ARRAY'] };
  }

  if (parsed.length === 0) {
    return { ok: false, errors: ['EMPTY_CRITERIA'] };
  }

  const errors: string[] = [];
  const criteria: OutcomePrimitive[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const prevErrorCount = errors.length;
    const result = validateElement(parsed[i], i, errors);
    if (errors.length === prevErrorCount && result !== null) {
      criteria.push(result);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, criteria };
}
