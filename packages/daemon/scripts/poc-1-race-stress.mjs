#!/usr/bin/env node
/**
 * PoC-1: MCP-call race window stress test
 *
 * Goal: Validate SQLite WAL + busy_timeout=5000ms can sustain N concurrent
 * writers (simulating N parallel mcp-server stdio subprocesses) hitting the
 * same checkpoints table.
 *
 * Design: worker_threads for true concurrency. Each worker opens its own
 * better-sqlite3 connection to the same DB file (mirrors how N concurrent
 * mcp-server subprocesses behave in the real architecture).
 *
 * Pass criteria (from pre-impl-validation §3.1, adapted):
 *  - Total success rate > 99.9%
 *  - p99 single-op latency < 100ms
 *  - SQLITE_BUSY errors fully absorbed by busy_timeout (zero unhandled)
 *
 * Run: node packages/daemon/scripts/poc-1-race-stress.mjs
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// daemon dist exports
const DAEMON_DIST = '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);

// ────────────────────────────────────────────────────────────────────────────
// Worker: opens its own DB connection, performs `opsPerWorker` inserts.
// ────────────────────────────────────────────────────────────────────────────
if (!isMainThread) {
  const { dbPath, workerId, opsPerWorker, sharedPath } = workerData;
  const { openDatabase, createPendingCheckpoint } = await import(DAEMON_DIST);

  const db = openDatabase(dbPath);
  const latencies = [];
  let successes = 0;
  let busyErrors = 0;
  let otherErrors = 0;
  const errorSamples = [];

  for (let i = 0; i < opsPerWorker; i++) {
    const t0 = process.hrtime.bigint();
    try {
      createPendingCheckpoint(db, {
        label: `w${workerId}-op${i}`,
        snapshot_dir: sharedPath, // intentional: all workers hit same path
      });
      const t1 = process.hrtime.bigint();
      latencies.push(Number(t1 - t0) / 1e6); // ns -> ms
      successes++;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
        busyErrors++;
      } else {
        otherErrors++;
      }
      if (errorSamples.length < 3) {
        errorSamples.push(msg);
      }
    }
  }

  db.close();
  parentPort.postMessage({
    workerId,
    successes,
    busyErrors,
    otherErrors,
    latencies,
    errorSamples,
  });
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────────────────
// Main thread: setup, spawn workers, aggregate results.
// ────────────────────────────────────────────────────────────────────────────
async function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-poc1-'));
  const dbPath = join(dir, 'cairn.db');

  const { openDatabase, runMigrations, ALL_MIGRATIONS } = await import(DAEMON_DIST);
  const db = openDatabase(dbPath);
  runMigrations(db, ALL_MIGRATIONS);
  db.close();

  return { dir, dbPath };
}

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(latencies) {
  if (latencies.length === 0) return null;
  return {
    n: latencies.length,
    p50: +pct(latencies, 50).toFixed(3),
    p95: +pct(latencies, 95).toFixed(3),
    p99: +pct(latencies, 99).toFixed(3),
    max: +pct(latencies, 100).toFixed(3),
    mean: +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(3),
  };
}

async function runScenario({ workerCount, opsPerWorker, scenarioName }) {
  const { dir, dbPath } = await setupDb();
  const sharedPath = '/tmp/poc-1-shared-target';

  const t0 = process.hrtime.bigint();

  const workerPromises = Array.from({ length: workerCount }, (_, workerId) => {
    return new Promise((resolve, reject) => {
      const w = new Worker(__filename, {
        workerData: { dbPath, workerId, opsPerWorker, sharedPath },
      });
      w.on('message', resolve);
      w.on('error', reject);
      w.on('exit', (code) => {
        if (code !== 0) reject(new Error(`worker ${workerId} exited code ${code}`));
      });
    });
  });

  const results = await Promise.all(workerPromises);
  const t1 = process.hrtime.bigint();
  const wallMs = Number(t1 - t0) / 1e6;

  // verify final row count
  const { openDatabase } = await import(DAEMON_DIST);
  const db = openDatabase(dbPath, { readonly: true });
  const row = db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get();
  const actualRowCount = row.n;
  db.close();

  // cleanup
  rmSync(dir, { recursive: true, force: true });

  const expectedTotal = workerCount * opsPerWorker;
  const successes = results.reduce((s, r) => s + r.successes, 0);
  const busyErrors = results.reduce((s, r) => s + r.busyErrors, 0);
  const otherErrors = results.reduce((s, r) => s + r.otherErrors, 0);
  const allLatencies = results.flatMap((r) => r.latencies);
  const errorSamples = [...new Set(results.flatMap((r) => r.errorSamples))].slice(0, 5);

  return {
    scenarioName,
    workerCount,
    opsPerWorker,
    expectedTotal,
    successes,
    successRate: +((successes / expectedTotal) * 100).toFixed(4),
    busyErrors,
    otherErrors,
    actualRowCount,
    rowMatchExpected: actualRowCount === successes,
    wallMs: +wallMs.toFixed(2),
    throughputOpsPerSec: +((successes / wallMs) * 1000).toFixed(2),
    latency: summarize(allLatencies),
    errorSamples,
  };
}

async function main() {
  console.log('PoC-1: MCP-call race window stress test');
  console.log('========================================');
  console.log(`Node: ${process.version}, platform: ${process.platform}`);
  console.log('');

  const scenarios = [
    { workerCount: 2, opsPerWorker: 500, scenarioName: 'N=2 baseline' },
    { workerCount: 5, opsPerWorker: 200, scenarioName: 'N=5 modest concurrency' },
    { workerCount: 10, opsPerWorker: 100, scenarioName: 'N=10 elevated' },
    { workerCount: 50, opsPerWorker: 20, scenarioName: 'N=50 stress' },
  ];

  const results = [];
  for (const sc of scenarios) {
    process.stdout.write(`Running ${sc.scenarioName} (${sc.workerCount} workers × ${sc.opsPerWorker} ops)...`);
    const res = await runScenario(sc);
    process.stdout.write(' done\n');
    results.push(res);
  }

  console.log('');
  console.log('Results');
  console.log('-------');
  for (const r of results) {
    console.log(`\n[${r.scenarioName}]`);
    console.log(`  total ops:        ${r.expectedTotal}`);
    console.log(`  successes:        ${r.successes} (${r.successRate}%)`);
    console.log(`  SQLITE_BUSY:      ${r.busyErrors}`);
    console.log(`  other errors:     ${r.otherErrors}`);
    console.log(`  rows in db:       ${r.actualRowCount} ${r.rowMatchExpected ? '(matches successes)' : '(MISMATCH!)'}`);
    console.log(`  wall time:        ${r.wallMs} ms`);
    console.log(`  throughput:       ${r.throughputOpsPerSec} ops/sec`);
    if (r.latency) {
      console.log(`  latency p50:      ${r.latency.p50} ms`);
      console.log(`  latency p95:      ${r.latency.p95} ms`);
      console.log(`  latency p99:      ${r.latency.p99} ms`);
      console.log(`  latency max:      ${r.latency.max} ms`);
      console.log(`  latency mean:     ${r.latency.mean} ms`);
    }
    if (r.errorSamples.length > 0) {
      console.log(`  error samples:    ${r.errorSamples.join(' | ')}`);
    }
  }

  // Pass-criteria check
  console.log('');
  console.log('Pass criteria check (per pre-impl-validation §3.1)');
  console.log('---------------------------------------------------');
  let allPass = true;
  for (const r of results) {
    const successOk = r.successRate >= 99.9;
    const p99Ok = !r.latency || r.latency.p99 < 100;
    const noUnhandledBusy = r.busyErrors === 0; // busy_timeout should absorb
    const rowMatchOk = r.rowMatchExpected;
    const scenarioPass = successOk && p99Ok && noUnhandledBusy && rowMatchOk;
    if (!scenarioPass) allPass = false;
    console.log(
      `  ${r.scenarioName}: ` +
        `success>=99.9% [${successOk ? 'PASS' : 'FAIL'}], ` +
        `p99<100ms [${p99Ok ? 'PASS' : 'FAIL'}], ` +
        `no unhandled BUSY [${noUnhandledBusy ? 'PASS' : 'FAIL'}], ` +
        `row count match [${rowMatchOk ? 'PASS' : 'FAIL'}]`
    );
  }
  console.log('');
  console.log(`OVERALL: ${allPass ? 'PASS — SQLite WAL baseline holds, conflict-detection layer can be built on top.' : 'FAIL — see details above; ARCHITECTURE may need stronger concurrency primitives.'}`);

  // Persist artifact
  const artifactDir = join(process.cwd(), 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, 'poc-1-results.json');
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        scenarios: results,
        verdict: allPass ? 'PASS' : 'FAIL',
      },
      null,
      2
    )
  );
  console.log('');
  console.log(`Artifact written: ${artifactPath}`);

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('PoC-1 crashed:', err);
  process.exit(2);
});
