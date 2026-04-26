export const LANE_STATES = [
  'RECORDED',
  'REVERTING',
  'REVERTED',
  'PARTIAL_REVERT',
  'HELD_FOR_HUMAN',
  'FAILED_RETRYABLE',
] as const;
export type LaneState = typeof LANE_STATES[number];

export const OP_CLASSIFICATIONS = [
  'SAFE_REVERT',
  'SEMANTIC_REVERT',
  'MARKED_REVERT',
  'NO_REVERT',
] as const;
export type OpClassification = typeof OP_CLASSIFICATIONS[number];

export const COMP_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'SUCCESS',
  'FAILED',
  'SKIPPED',
] as const;
export type CompStatus = typeof COMP_STATUSES[number];

export interface LaneRow {
  id: string;
  task_id: string | null;
  sub_agent_id: string | null;
  checkpoint_id: string | null;
  endpoint: string;
  scenario: string | null;
  state: LaneState;
  lock_holder: string | null;
  lock_expires_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface OpRow {
  id: string;
  lane_id: string;
  seq: number;
  method: string;
  url: string;
  target: string | null;
  request_body_json: string | null;
  request_body_path: string | null;
  response_status: number | null;
  response_body_json: string | null;
  response_body_path: string | null;
  before_image_json: string | null;
  before_image_path: string | null;
  classification: OpClassification;
  created_at: number;
}

export interface CompensationRow {
  id: string;
  op_id: string;
  strategy: string;
  payload_json: string | null;
  payload_path: string | null;
  status: CompStatus;
  attempt: number;
  max_attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScratchpadRow {
  key: string;
  value_json: string | null;
  value_path: string | null;
  task_id: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export const CHECKPOINT_STATUSES = ['PENDING', 'READY', 'CORRUPTED'] as const;
export type CheckpointStatus = typeof CHECKPOINT_STATUSES[number];

export interface CheckpointRow {
  id: string;
  task_id: string | null;
  label: string | null;
  git_head: string | null;
  snapshot_dir: string;
  snapshot_status: CheckpointStatus;
  size_bytes: number | null;
  created_at: number;
  ready_at: number | null;
}
