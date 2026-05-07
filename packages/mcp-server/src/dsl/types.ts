export type PrimitiveName =
  | 'tests_pass'
  | 'command_exits_0'
  | 'file_exists'
  | 'regex_matches'
  | 'scratchpad_key_exists'
  | 'no_open_conflicts'
  | 'checkpoint_created_after';

// Discriminated union — each primitive's args shape is type-checked at call site
export type OutcomePrimitive =
  | { primitive: 'tests_pass';                args: { target?: string } }
  | { primitive: 'command_exits_0';           args: { cmd: string; cwd?: string } }
  | { primitive: 'file_exists';               args: { path: string } }
  | { primitive: 'regex_matches';             args: { file: string; pattern: string; flags?: string } }
  | { primitive: 'scratchpad_key_exists';     args: { key: string; task_id?: string } }
  | { primitive: 'no_open_conflicts';         args: { scope_paths?: string[] } }
  | { primitive: 'checkpoint_created_after';  args: { timestamp: number; task_id?: string } };

// Resource access class — declared per primitive for LD-10 enforcement
export type AccessClass = 'FILE' | 'COMMAND' | 'DB';
export const PRIMITIVE_ACCESS: Record<PrimitiveName, AccessClass[]> = {
  tests_pass:                ['COMMAND', 'FILE'],
  command_exits_0:           ['COMMAND'],
  file_exists:               ['FILE'],
  regex_matches:             ['FILE'],
  scratchpad_key_exists:     ['DB'],
  no_open_conflicts:         ['DB'],
  checkpoint_created_after:  ['DB'],
};

export interface EvaluationResultPerPrimitive {
  primitive: PrimitiveName;
  args: unknown;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  detail: string;
  elapsed_ms: number;
}

export interface EvaluationResult {
  status: 'PASS' | 'FAIL';
  perPrimitive: EvaluationResultPerPrimitive[];
  summary: string;
}

// LD-11: reserved hook for future grader agent integration; v1 ignores
export interface GraderHook {
  evaluate(criteria: OutcomePrimitive[], ctx: { task_id: string }): Promise<EvaluationResult>;
}
