import { readFileSync } from 'node:fs';
import type { Database as DB } from 'better-sqlite3';
import { writeBlobIfLarge } from '../storage/blobs.js';
import { newId } from '../storage/ids.js';

interface PocLane {
  laneId: string;
  endpoint: string;
  target: string;
  createdAt: string;
  compensator: unknown;
  forwardRequest: unknown;
  forwardResponse: { status: number; body: unknown };
  beforeImage: unknown;
}

export function importPocLane(
  db: DB,
  blobRoot: string,
  jsonPath: string,
  scenario: string
): void {
  const poc = JSON.parse(readFileSync(jsonPath, 'utf8')) as PocLane;
  const createdAt = Date.parse(poc.createdAt);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO lanes (id, endpoint, scenario, state, created_at, updated_at)
       VALUES (?, ?, ?, 'RECORDED', ?, ?)`
    ).run(poc.laneId, poc.endpoint, scenario, createdAt, createdAt);

    const opId = newId();
    const req = writeBlobIfLarge(poc.forwardRequest, blobRoot);
    const res = writeBlobIfLarge(poc.forwardResponse.body, blobRoot);
    const bef = writeBlobIfLarge(poc.beforeImage, blobRoot);

    db.prepare(
      `INSERT INTO ops
         (id, lane_id, seq, method, url, target,
          request_body_json, request_body_path,
          response_status, response_body_json, response_body_path,
          before_image_json, before_image_path,
          classification, created_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SAFE_REVERT', ?)`
    ).run(
      opId, poc.laneId,
      (poc.forwardRequest as any).method ?? 'UNKNOWN',
      poc.target, poc.target,
      req.json ?? null, req.path ?? null,
      poc.forwardResponse.status,
      res.json ?? null, res.path ?? null,
      bef.json ?? null, bef.path ?? null,
      createdAt
    );

    const pay = writeBlobIfLarge(poc.compensator, blobRoot);
    db.prepare(
      `INSERT INTO compensations
         (id, op_id, strategy, payload_json, payload_path,
          status, attempt, max_attempts, created_at, updated_at)
       VALUES (?, ?, 'reverse_http', ?, ?, 'PENDING', 0, 3, ?, ?)`
    ).run(newId(), opId, pay.json ?? null, pay.path ?? null, createdAt, createdAt);
  })();
}
