#!/usr/bin/env node
/**
 * PoC-2 bench: measure end-to-end git pre-commit hook latency.
 *
 * Spawns `node poc-2-conflict-check.mjs` K times per scenario (varying number
 * of staged paths) to measure realistic wall-clock latency including Node
 * startup overhead. This is what users actually experience on every commit.
 *
 * Run: node packages/daemon/scripts/poc-2-hook-bench.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK_SCRIPT = join(__dirname, 'poc-2-conflict-check.mjs');
const DAEMON_DIST = '../dist/index.js';

// ────────────────────────────────────────────────────────────────────────────

async function setupSeededDb({ checkpointCount = 100 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-poc2-'));
  const dbPath = join(dir, 'cairn.db');

  const {
    openDatabase,
    runMigrations,
    ALL_MIGRATIONS,
    createPendingCheckpoint,
    markCheckpointReady,
  } = await import(DAEMON_DIST);

  const db = openDatabase(dbPath);
  runMigrations(db, ALL_MIGRATIONS);

  // Seed checkpoints: half READY (visible to hook), half PENDING (filtered
  // out). Spread created_at across last 90 minutes; some are within 60-min
  // window the hook checks, some outside.
  const now = Date.now();
  for (let i = 0; i < checkpointCount; i++) {
    const taskId = `T${i % 5}`; // 5 distinct tasks
    const c = createPendingCheckpoint(db, {
      task_id: taskId,
      label: `seed-${i}-touches-src/file${i % 50}.ts`,
      snapshot_dir: `/tmp/cairn-snap/${i}-src-file${i % 50}`,
    });
    if (i % 2 === 0) {
      markCheckpointReady(db, c.id, { size_bytes: 1024, git_head: `head${i}` });
    }
    // Backdate created_at on a quarter of rows so they're outside 60-min window
    if (i % 4 === 0) {
      db.prepare(`UPDATE checkpoints SET created_at = ? WHERE id = ?`).run(
        now - 90 * 60 * 1000 - i * 1000,
        c.id
      );
    } else {
      db.prepare(`UPDATE checkpoints SET created_at = ? WHERE id = ?`).run(
        now - (i * 30 * 1000), // spread last ~50 min
        c.id
      );
    }
  }

  db.close();
  return { dir, dbPath };
}

function generatePaths(n) {
  return Array.from({ length: n }, (_, i) => `src/module${i % 50}/file${i}.ts`);
}

function spawnHook({ dbPath, paths, taskId = 'BENCH-TASK' }) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const args = [
      HOOK_SCRIPT,
      '--db',
      dbPath,
      '--paths',
      paths.join(','),
      '--task-id',
      taskId,
    ];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => {
      const t1 = process.hrtime.bigint();
      const wallMs = Number(t1 - t0) / 1e6;
      resolve({ exitCode: code, wallMs, stderr });
    });
    child.on('error', reject);
  });
}

function summarize(latencies) {
  if (latencies.length === 0) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    n: latencies.length,
    min: +sorted[0].toFixed(2),
    p50: +pct(50).toFixed(2),
    p95: +pct(95).toFixed(2),
    p99: +pct(99).toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
    mean: +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2),
  };
}

async function runScenario({ name, dbPath, pathCount, iterations, expectFailOpen = false }) {
  const wallTimes = [];
  let nonZeroExits = 0;
  let lastStderr = '';

  for (let i = 0; i < iterations; i++) {
    const paths = generatePaths(pathCount);
    const r = await spawnHook({ dbPath, paths });
    wallTimes.push(r.wallMs);
    if (r.exitCode !== 0) nonZeroExits++;
    lastStderr = r.stderr;
  }

  return {
    name,
    pathCount,
    iterations,
    expectFailOpen,
    nonZeroExits,
    failOpenPass: expectFailOpen ? nonZeroExits === 0 : null,
    wall: summarize(wallTimes),
    sampleStderr: lastStderr.split('\n').slice(0, 3).join(' | '),
  };
}

async function main() {
  console.log('PoC-2: git pre-commit hook latency bench');
  console.log('==========================================');
  console.log(`Node: ${process.version}, platform: ${process.platform}`);
  console.log('');

  const { dir, dbPath } = await setupSeededDb({ checkpointCount: 100 });
  console.log(`DB seeded: ${dbPath} (100 checkpoints, last ~90 min)`);
  console.log('');

  const scenarios = [
    { name: 'clean (0 paths)', pathCount: 0, iterations: 20 },
    { name: 'small (10 paths)', pathCount: 10, iterations: 20 },
    { name: 'medium (100 paths)', pathCount: 100, iterations: 20 },
    { name: 'large (1000 paths)', pathCount: 1000, iterations: 10 },
  ];

  const results = [];
  for (const sc of scenarios) {
    process.stdout.write(`Running ${sc.name} × ${sc.iterations} iters...`);
    const r = await runScenario({ dbPath, ...sc });
    process.stdout.write(' done\n');
    results.push(r);
  }

  // Fail-open scenario: point at non-existent DB
  process.stdout.write('Running fail-open (DB missing) × 10 iters...');
  const failOpenRes = await runScenario({
    name: 'fail-open (DB missing)',
    dbPath: '/this/path/does/not/exist/cairn.db',
    pathCount: 10,
    iterations: 10,
    expectFailOpen: true,
  });
  process.stdout.write(' done\n');
  results.push(failOpenRes);

  // ────────────────────────────────────────────────────────────────────────
  // Report
  console.log('');
  console.log('Results');
  console.log('-------');
  for (const r of results) {
    console.log(`\n[${r.name}]`);
    console.log(`  iterations:       ${r.iterations}`);
    console.log(`  non-zero exits:   ${r.nonZeroExits}${r.expectFailOpen ? ' (fail-open expected)' : ''}`);
    if (r.wall) {
      console.log(`  wall p50:         ${r.wall.p50} ms`);
      console.log(`  wall p95:         ${r.wall.p95} ms`);
      console.log(`  wall p99:         ${r.wall.p99} ms`);
      console.log(`  wall max:         ${r.wall.max} ms`);
      console.log(`  wall mean:        ${r.wall.mean} ms`);
    }
    if (r.sampleStderr) {
      console.log(`  sample stderr:    ${r.sampleStderr.slice(0, 200)}`);
    }
  }

  // Pass criteria check
  console.log('');
  console.log('Pass criteria check (per pre-impl-validation §3.2)');
  console.log('---------------------------------------------------');
  let allPass = true;
  for (const r of results) {
    if (r.expectFailOpen) {
      const failOpenPass = r.nonZeroExits === 0;
      if (!failOpenPass) allPass = false;
      console.log(`  ${r.name}: fail-open (exit=0 always) [${failOpenPass ? 'PASS' : 'FAIL'}]`);
      continue;
    }
    // Choose threshold: small <= 100 paths => 200ms; > 100 => 1000ms
    const threshold = r.pathCount > 100 ? 1000 : 200;
    const p99Pass = r.wall && r.wall.p99 < threshold;
    const exitPass = r.nonZeroExits === 0;
    const scenarioPass = p99Pass && exitPass;
    if (!scenarioPass) allPass = false;
    console.log(
      `  ${r.name}: ` +
        `p99<${threshold}ms (${r.wall?.p99 ?? 'n/a'}ms) [${p99Pass ? 'PASS' : 'FAIL'}], ` +
        `exit=0 [${exitPass ? 'PASS' : 'FAIL'}]`
    );
  }
  console.log('');
  console.log(`OVERALL: ${allPass ? 'PASS — commit-after hook latency budget holds; fail-open works.' : 'FAIL — see details; see docs/superpowers/plans/2026-04-29-poc-2-results.md for fallback options.'}`);

  // Cleanup
  rmSync(dir, { recursive: true, force: true });

  // Persist artifact
  const artifactDir = join(process.cwd(), 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, 'poc-2-results.json');
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
  console.error('PoC-2 crashed:', err);
  process.exit(2);
});
