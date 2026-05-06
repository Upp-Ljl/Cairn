import type { Database as DB } from 'better-sqlite3';
import type { Workspace } from '../workspace.js';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface InspectorQueryResult {
  matched: boolean;
  intent: string;
  sql?: string;
  results?: unknown[];
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

interface Template {
  /** Ordered list of keyword sets — first one that matches wins (longest first). */
  keywords: string[];
  intent: string;
  /**
   * Build the SQL and params for a given query string.
   * Returns { sql, params } ready to pass to better-sqlite3 .all().
   */
  buildQuery: (query: string) => { sql: string; params: unknown[] };
}

/**
 * Try to extract a task_id from patterns like:
 *   "checkpoints for task abc-123"
 *   "task abc-123 的 checkpoint"
 */
function extractTaskId(query: string): string | null {
  const m = query.match(/(?:for\s+task\s+|task\s+)([a-z0-9_\-./]+)/i);
  return m ? (m[1] ?? null) : null;
}

/**
 * Try to extract a path from patterns like:
 *   "conflicts for path src/foo.ts"
 *   "src/foo.ts 的冲突"
 */
function extractPath(query: string): string | null {
  // "for path X" pattern
  const m1 = query.match(/for\s+path\s+(\S+)/i);
  if (m1) return m1[1] ?? null;
  // "X 的冲突" pattern — grab the token before "的冲突"
  const m2 = query.match(/(\S+)\s*的冲突/);
  if (m2) return m2[1] ?? null;
  return null;
}

/** Return today start (midnight UTC) as a unix timestamp in ms. */
function todayStartMs(): number {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now.getTime();
}

const TEMPLATES: Template[] = [
  // ── Processes ──────────────────────────────────────────────────────────────

  {
    keywords: ['active agents', '活跃 agent', 'agents alive', '活跃agent'],
    intent: 'list_active_agents',
    buildQuery: () => ({
      sql: "SELECT * FROM processes WHERE status IN ('ACTIVE','IDLE') ORDER BY last_heartbeat DESC LIMIT 100",
      params: [],
    }),
  },
  {
    keywords: ['dead agents', '已死', 'stale agents'],
    intent: 'list_dead_agents',
    buildQuery: () => ({
      sql: "SELECT * FROM processes WHERE status = 'DEAD' ORDER BY last_heartbeat DESC LIMIT 100",
      params: [],
    }),
  },
  {
    keywords: ['all agents', '所有 agent', '所有agent', 'all processes'],
    intent: 'list_all_agents',
    buildQuery: () => ({
      sql: "SELECT * FROM processes ORDER BY last_heartbeat DESC LIMIT 100",
      params: [],
    }),
  },

  // ── Conflicts ──────────────────────────────────────────────────────────────

  {
    keywords: ['all conflicts today', '今天的冲突', 'conflicts today'],
    intent: 'list_conflicts_today',
    buildQuery: () => ({
      sql: 'SELECT * FROM conflicts WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 100',
      params: [todayStartMs()],
    }),
  },
  {
    keywords: ['conflicts for path', '的冲突'],
    intent: 'list_conflicts_for_path',
    buildQuery: (query) => {
      const path = extractPath(query) ?? '';
      return {
        sql: 'SELECT * FROM conflicts WHERE paths_json LIKE ? ORDER BY detected_at DESC LIMIT 100',
        params: [`%${path}%`],
      };
    },
  },
  {
    keywords: ['open conflicts', '未解决冲突', 'unresolved conflicts'],
    intent: 'list_open_conflicts',
    buildQuery: () => ({
      sql: "SELECT * FROM conflicts WHERE status = 'OPEN' ORDER BY detected_at DESC LIMIT 100",
      params: [],
    }),
  },
  {
    keywords: ['recent conflicts', '最近冲突', 'latest conflicts'],
    intent: 'list_recent_conflicts',
    buildQuery: () => ({
      sql: 'SELECT * FROM conflicts ORDER BY detected_at DESC LIMIT 10',
      params: [],
    }),
  },

  // ── Checkpoints ────────────────────────────────────────────────────────────

  {
    keywords: ['checkpoints for task', 'task 的 checkpoint', 'task的checkpoint'],
    intent: 'list_checkpoints_for_task',
    buildQuery: (query) => {
      const taskId = extractTaskId(query) ?? '';
      return {
        sql: 'SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 100',
        params: [taskId],
      };
    },
  },
  {
    keywords: ['recent checkpoints', '最近 checkpoint', '最近checkpoint', 'latest checkpoints'],
    intent: 'list_recent_checkpoints',
    buildQuery: () => ({
      sql: 'SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT 10',
      params: [],
    }),
  },

  // ── Scratchpad ─────────────────────────────────────────────────────────────

  {
    keywords: ['scratchpad for task', 'task 的 scratchpad'],
    intent: 'list_scratchpad_for_task',
    buildQuery: (query) => {
      const taskId = extractTaskId(query) ?? '';
      return {
        sql: 'SELECT key, task_id, expires_at, created_at, updated_at FROM scratchpad WHERE task_id = ? ORDER BY updated_at DESC LIMIT 100',
        params: [taskId],
      };
    },
  },
  {
    keywords: ['scratchpad keys', 'scratchpad 列表', 'scratchpad列表', 'list scratchpad', 'all scratchpad'],
    intent: 'list_scratchpad_keys',
    buildQuery: () => ({
      sql: 'SELECT key, task_id, expires_at, created_at, updated_at FROM scratchpad ORDER BY updated_at DESC LIMIT 100',
      params: [],
    }),
  },

  // ── Dispatch requests ──────────────────────────────────────────────────────

  {
    keywords: ['pending dispatch', '待确认', 'pending requests'],
    intent: 'list_pending_dispatch',
    buildQuery: () => ({
      sql: "SELECT * FROM dispatch_requests WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT 100",
      params: [],
    }),
  },
  {
    keywords: ['confirmed dispatch', '已确认派单', 'confirmed requests'],
    intent: 'list_confirmed_dispatch',
    buildQuery: () => ({
      sql: "SELECT * FROM dispatch_requests WHERE status = 'CONFIRMED' ORDER BY created_at DESC LIMIT 100",
      params: [],
    }),
  },
  {
    keywords: ['recent dispatch requests', '最近的派单', '派单历史', 'dispatch history', 'recent dispatch'],
    intent: 'list_recent_dispatch',
    buildQuery: () => ({
      sql: 'SELECT * FROM dispatch_requests ORDER BY created_at DESC LIMIT 10',
      params: [],
    }),
  },

  // ── Summary / Stats ────────────────────────────────────────────────────────

  {
    keywords: ['stats', '数字', 'summary', '摘要', 'overview', '总览'],
    intent: 'summary_stats',
    buildQuery: () => ({
      sql: `
        SELECT
          (SELECT COUNT(*) FROM processes WHERE status IN ('ACTIVE','IDLE')) AS active_agents,
          (SELECT COUNT(*) FROM conflicts WHERE status = 'OPEN')              AS open_conflicts,
          (SELECT COUNT(*) FROM checkpoints)                                  AS total_checkpoints,
          (SELECT COUNT(*) FROM dispatch_requests WHERE status = 'PENDING')   AS pending_dispatch
      `.trim(),
      params: [],
    }),
  },
];

// ---------------------------------------------------------------------------
// Suggestion list for unmatched queries
// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  '"active agents" — list ACTIVE/IDLE agents',
  '"all agents" — include DEAD agents',
  '"dead agents" — list only DEAD agents',
  '"recent conflicts" — last 10 conflicts',
  '"open conflicts" — conflicts with status OPEN',
  '"all conflicts today" — conflicts detected today',
  '"conflicts for path src/foo.ts" — conflicts touching a specific path',
  '"recent checkpoints" — last 10 checkpoints',
  '"checkpoints for task my-task-id" — checkpoints for a specific task',
  '"scratchpad keys" — list all scratchpad entries',
  '"scratchpad for task my-task-id" — scratchpad for a task',
  '"recent dispatch requests" — last 10 dispatch requests',
  '"pending dispatch" — dispatch requests awaiting confirmation',
  '"confirmed dispatch" — confirmed dispatch requests',
  '"stats" — cross-table summary (agents / conflicts / checkpoints / dispatch)',
];

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

/**
 * Find the best matching template for a given (already lower-cased, trimmed) query.
 * Prefers longer keyword matches over shorter ones.
 */
function findTemplate(q: string): { template: Template; keyword: string } | null {
  let best: { template: Template; keyword: string } | null = null;
  let bestLen = 0;

  for (const tpl of TEMPLATES) {
    for (const kw of tpl.keywords) {
      if (q.includes(kw) && kw.length > bestLen) {
        best = { template: tpl, keyword: kw };
        bestLen = kw.length;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public tool handler
// ---------------------------------------------------------------------------

export interface InspectorQueryArgs {
  query: string;
}

export function toolInspectorQuery(ws: Workspace, args: InspectorQueryArgs): InspectorQueryResult {
  const rawQuery = (args.query ?? '').trim();

  if (rawQuery.length === 0) {
    return {
      matched: false,
      intent: 'no_query',
      suggestion: 'Query is empty. Try one of:\n' + SUGGESTIONS.join('\n'),
    };
  }

  const q = rawQuery.toLowerCase();
  const match = findTemplate(q);

  if (!match) {
    return {
      matched: false,
      intent: 'unmatched',
      suggestion: `No template matched "${rawQuery}". Try one of:\n` + SUGGESTIONS.join('\n'),
    };
  }

  const { sql, params } = match.template.buildQuery(q);
  const results = runQuery(ws.db, sql, params);

  return {
    matched: true,
    intent: match.template.intent,
    sql,
    results,
  };
}

// ---------------------------------------------------------------------------
// Internal helper — run query safely
// ---------------------------------------------------------------------------

function runQuery(db: DB, sql: string, params: unknown[]): unknown[] {
  const stmt = db.prepare(sql);
  const rows = stmt.all(...params);
  return rows;
}
