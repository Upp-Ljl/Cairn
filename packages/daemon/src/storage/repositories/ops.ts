import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';
import { writeBlobIfLarge } from '../blobs.js';
import type { OpRow, OpClassification } from '../types.js';

export interface NewOp {
  method: string;
  url: string;
  target?: string | null;
  classification: OpClassification;
  request_body?: unknown;
  response_status?: number | null;
  response_body?: unknown;
  before_image?: unknown;
}

export function appendOp(db: DB, blobRoot: string, laneId: string, input: NewOp): OpRow {
  return db.transaction(() => {
    const seqRow = db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM ops WHERE lane_id = ?')
      .get(laneId) as { next: number };

    const req = input.request_body !== undefined
      ? writeBlobIfLarge(input.request_body, blobRoot) : {};
    const res = input.response_body !== undefined
      ? writeBlobIfLarge(input.response_body, blobRoot) : {};
    const bef = input.before_image !== undefined
      ? writeBlobIfLarge(input.before_image, blobRoot) : {};

    const row: OpRow = {
      id: newId(),
      lane_id: laneId,
      seq: seqRow.next,
      method: input.method,
      url: input.url,
      target: input.target ?? null,
      request_body_json: req.json ?? null,
      request_body_path: req.path ?? null,
      response_status: input.response_status ?? null,
      response_body_json: res.json ?? null,
      response_body_path: res.path ?? null,
      before_image_json: bef.json ?? null,
      before_image_path: bef.path ?? null,
      classification: input.classification,
      created_at: Date.now(),
    };

    db.prepare(
      `INSERT INTO ops
         (id, lane_id, seq, method, url, target,
          request_body_json, request_body_path,
          response_status, response_body_json, response_body_path,
          before_image_json, before_image_path,
          classification, created_at)
       VALUES
         (@id, @lane_id, @seq, @method, @url, @target,
          @request_body_json, @request_body_path,
          @response_status, @response_body_json, @response_body_path,
          @before_image_json, @before_image_path,
          @classification, @created_at)`
    ).run(row);

    return row;
  })();
}

export function listOpsByLane(db: DB, laneId: string): OpRow[] {
  return db
    .prepare('SELECT * FROM ops WHERE lane_id = ? ORDER BY seq ASC')
    .all(laneId) as OpRow[];
}
