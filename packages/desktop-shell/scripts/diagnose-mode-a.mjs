#!/usr/bin/env node
/**
 * diagnose-mode-a.mjs — explain WHY Mode A isn't dispatching for a
 * given project. Reads the user's real ~/.cairn/projects.json and the
 * project's DB; reports each gate the loop has to clear, with a green
 * ✓ / red ✗ verdict per gate.
 *
 * Read-only: never writes anything. Safe to run on live state.
 *
 * Usage:
 *   node packages/desktop-shell/scripts/diagnose-mode-a.mjs              # all projects
 *   node packages/desktop-shell/scripts/diagnose-mode-a.mjs <project_id> # one project
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const Database = require(path.join(dsRoot, 'node_modules', 'better-sqlite3'));
const registry = require(path.join(dsRoot, 'registry.cjs'));
const projectQueries = require(path.join(dsRoot, 'project-queries.cjs'));
const modeALoop = require(path.join(dsRoot, 'mode-a-loop.cjs'));

const targetProjectId = process.argv[2] || null;

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const C = '\x1b[36m';
const D = '\x1b[2m';
const N = '\x1b[0m';

function ok(s)   { console.log(`  ${G}✓${N} ${s}`); }
function bad(s)  { console.log(`  ${R}✗${N} ${s}`); }
function warn(s) { console.log(`  ${Y}!${N} ${s}`); }
function info(s) { console.log(`    ${D}${s}${N}`); }
function header(t) { console.log(`\n${C}${'='.repeat(70)}\n${t}\n${'='.repeat(70)}${N}`); }
function sub(t) { console.log(`\n${C}[${t}]${N}`); }

header('diagnose-mode-a');

// Load registry.
const reg = registry.loadRegistry();
if (!reg || !Array.isArray(reg.projects) || reg.projects.length === 0) {
  bad('no projects found in ~/.cairn/projects.json');
  process.exit(0);
}
console.log(`${D}registry has ${reg.projects.length} project(s)${N}`);

const projectsToCheck = targetProjectId
  ? reg.projects.filter(p => p.id === targetProjectId)
  : reg.projects;

if (projectsToCheck.length === 0) {
  bad(`project_id "${targetProjectId}" not found`);
  process.exit(0);
}

let anyBlockers = false;
const DB_PATH_SENTINELS = new Set(['/dev/null', '(unknown)']);

for (const project of projectsToCheck) {
  header(`PROJECT: ${project.label || project.id}`);
  console.log(`  id           ${project.id}`);
  console.log(`  project_root ${project.project_root}`);
  console.log(`  db_path      ${project.db_path}`);

  // Gate 1: mode === 'A'?
  sub('Gate 1: 项目是 Mode A?');
  const settings = registry.getCockpitSettings(reg, project.id);
  if (settings.mode === 'A') {
    ok(`mode = 'A' — 自动驾驶 已开`);
  } else {
    bad(`mode = '${settings.mode}' — Mode A 还没开。面板顶部点 "A · 自动驾驶"`);
    anyBlockers = true;
    continue;
  }

  // Gate 2: goal set with success_criteria?
  sub('Gate 2: goal 是否填写 + 有 success_criteria?');
  const goal = registry.getProjectGoal(reg, project.id);
  if (!goal) {
    bad('没设 goal — 面板里 ✎ Define goal 先');
    anyBlockers = true;
    continue;
  }
  ok(`goal: "${goal.title || '(无标题)'}"`);
  const sc = Array.isArray(goal.success_criteria) ? goal.success_criteria.filter(s => typeof s === 'string' && s.trim()) : [];
  if (sc.length === 0) {
    bad(`goal.success_criteria 为空 — Mode A 计划没有步骤。在 goal 编辑里加几条 success_criteria`);
    anyBlockers = true;
    continue;
  }
  ok(`success_criteria: ${sc.length} 条`);
  for (let i = 0; i < sc.length; i++) info(`#${i + 1} ${sc[i]}`);

  // Open DB.
  sub('Gate 3: DB 可访问?');
  let dbPath = project.db_path;
  if (!dbPath || DB_PATH_SENTINELS.has(dbPath)) {
    dbPath = path.join(os.homedir(), '.cairn', 'cairn.db');
    warn(`db_path 是 sentinel ('${project.db_path}')，回落到默认 ${dbPath}`);
  }
  if (!fs.existsSync(dbPath)) {
    bad(`DB 文件不存在: ${dbPath} — 还没有 mcp-server session 在这个项目里跑过`);
    anyBlockers = true;
    continue;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    ok(`DB 打开: ${dbPath}`);
  } catch (e) {
    bad(`DB 打开失败: ${e.message}`);
    anyBlockers = true;
    continue;
  }
  const tables = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name),
  );

  // Gate 4: agent hints resolve to a non-empty list?
  sub('Gate 4: 项目能 attribution 到 agent_id?');
  const agentIds = projectQueries.resolveProjectAgentIds(db, tables, project);
  const hints = Array.from(agentIds || []);
  if (hints.length === 0) {
    bad('没有任何 agent_id 能归到这个项目 — mentor-tick 会直接 skip。');
    info('修法：在项目里开一个新的 CC session（mcp-server 会自动注册 + 写 capabilities 标签）');
    anyBlockers = true;
    db.close();
    continue;
  }
  ok(`${hints.length} 个 agent_id 关联到项目`);
  for (const h of hints) info(h);

  // Gate 5: 至少一个 ACTIVE process?
  sub('Gate 5: 至少一个 ACTIVE process（派单目标必须 ACTIVE）?');
  let activeRows = [];
  try {
    const placeholders = '(' + hints.map(() => '?').join(',') + ')';
    activeRows = db.prepare(`
      SELECT agent_id, agent_type, status, last_heartbeat
      FROM processes
      WHERE agent_id IN ${placeholders}
    `).all(...hints);
  } catch (e) {
    bad(`processes 表查询失败: ${e.message}`);
    db.close();
    anyBlockers = true;
    continue;
  }
  const active = activeRows.filter(r => r.status === 'ACTIVE');
  console.log(`    processes row 状态分布:`);
  for (const r of activeRows) {
    const ageSec = Math.round((Date.now() - (r.last_heartbeat || 0)) / 1000);
    const ageStr = ageSec < 60 ? `${ageSec}s` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m` : `${Math.round(ageSec / 3600)}h`;
    const tag = r.status === 'ACTIVE' ? `${G}${r.status}${N}` : `${R}${r.status}${N}`;
    info(`${tag.padEnd(20)} ${r.agent_id.slice(0, 18)} type=${r.agent_type} last_heartbeat ${ageStr} ago`);
  }
  if (active.length === 0) {
    bad('零个 ACTIVE process — Mode A 无法派单。');
    info('修法：在项目目录下开一个新的 Claude Code session，mcp-server 启动后会 INSERT 一行 status=ACTIVE');
    info('面板里截图显示的 IDLE / STALE 是 panel-side derived 标签，对应的 processes.status 可能已经是 DEAD 或心跳过期');
    anyBlockers = true;
    db.close();
    continue;
  }
  ok(`${active.length} 个 ACTIVE process`);

  // Gate 6: plan in scratchpad?
  sub('Gate 6: Mode A 计划是否已经起草?');
  if (!tables.has('scratchpad')) {
    bad('scratchpad 表不存在 — DB 太老，跑过 cairn install 吗?');
    db.close(); anyBlockers = true; continue;
  }
  const plan = modeALoop.getPlan(db, project.id);
  if (!plan) {
    warn('scratchpad 里没有 mode_a_plan 行');
    info('下一次 mentor-tick (≤30s) 会起草');
  } else {
    ok(`plan_id=${plan.plan_id.slice(0, 12)}, status=${plan.status}, current_idx=${plan.current_idx}/${plan.steps.length}`);
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      const marker = i === plan.current_idx ? '▶' : (s.state === 'DONE' ? '✓' : (s.state === 'DISPATCHED' ? '⏳' : (s.state === 'FAILED' ? '✗' : '·')));
      info(`${marker} [${s.state}] ${s.label}${s.dispatch_id ? ` (disp=${s.dispatch_id.slice(0, 10)})` : ''}`);
    }
  }

  // Gate 7: dispatch_requests for Mode A?
  sub('Gate 7: Mode A 派过单吗?');
  if (tables.has('dispatch_requests')) {
    try {
      const drs = db.prepare(`
        SELECT id, nl_intent, status, target_agent, task_id, created_at
        FROM dispatch_requests
        WHERE nl_intent LIKE '%mode-a-loop%'
        ORDER BY created_at DESC LIMIT 5
      `).all();
      if (drs.length === 0) {
        warn('没 Mode A 派单记录（可能 plan 还没起草 / 没 ACTIVE agent）');
      } else {
        ok(`${drs.length} 条 Mode A 派单（最近 5）`);
        for (const d of drs) {
          info(`${d.status.padEnd(10)} target=${d.target_agent.slice(0,18)} task_id=${d.task_id || '(未确认)'} | ${d.nl_intent.slice(0, 80)}`);
        }
      }
    } catch (e) {
      bad(`dispatch_requests 查询失败: ${e.message}`);
    }
  }

  // Gate 8: 最近的 cairn.log 事件
  sub('Gate 8: 最近的 mentor-tick / mode-a-loop log 事件?');
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(os.homedir(), '.cairn', 'logs', `cairn-${today}.jsonl`);
  if (!fs.existsSync(logPath)) {
    warn(`今天的 log 文件不存在: ${logPath}`);
  } else {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const relevant = lines
      .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter(e => e && (e.component === 'mentor-tick' || e.component === 'mode-a-loop' || e.component === 'mode-a-auto-answer'))
      .filter(e => !e.project_id || e.project_id === project.id)
      .slice(-10);
    if (relevant.length === 0) {
      warn('今天没有任何 mentor-tick / mode-a-loop log — 面板可能没起来，或 mentor-tick 没启动');
    } else {
      ok(`${relevant.length} 条相关 log（最近 10）`);
      for (const e of relevant) {
        info(`${e.ts_iso.slice(11, 19)} ${e.component}/${e.event}${e.action ? ' action=' + e.action : ''}${e.rule ? ' rule=' + e.rule : ''}${e.error ? ' err=' + e.error.slice(0,40) : ''}`);
      }
    }
  }

  db.close();
}

console.log('');
if (anyBlockers) {
  console.log(`${Y}— 有 gate 没通过；按上面的 ${R}✗${Y} 提示挨个修。${N}`);
} else {
  console.log(`${G}— 所有 gate 都过了。30 秒内（下一次 mentor-tick）Mode A 应该会派单。${N}`);
}
