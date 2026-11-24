import type Database from 'better-sqlite3';
import { peek } from '../proxy/counter.js';

// Read-only projections for the dashboard. Nothing here writes.

export interface TaskRollup {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  tokens: number;
  usd: number;
  steps: number;
  estimated: number;
  unpriced: number;
}

export interface UntrackedRollup {
  tokens: number;
  usd: number;
  steps: number;
  estimated: number;
  unpriced: number;
}

export interface FeedRow {
  id: string;
  taskId: string | null;
  agent: string;
  model: string;
  ts: number;
  tokens: number;
  usd: number;
  status: string;
  estimated: number;
  unpriced: number;
}

interface TaskSqlRow {
  id: string;
  name: string;
  status: string;
  created_at: number;
  tokens: number;
  usd: number;
  steps: number;
  estimated: number;
  unpriced: number;
}

const TASK_SQL = `
SELECT t.id, t.name, t.status, t.created_at,
       COALESCE(SUM(r.prompt_tokens + r.completion_tokens), 0) AS tokens,
       COALESCE(SUM(r.est_cost), 0) AS usd,
       COUNT(r.id) AS steps,
       COALESCE(SUM(r.estimated), 0) AS estimated,
       EXISTS (
         SELECT 1 FROM events e JOIN requests r2 ON r2.id = e.request_id
          WHERE r2.task_id = t.id AND e.type = 'unpriced_model'
       ) AS unpriced
  FROM tasks t LEFT JOIN requests r ON r.task_id = t.id
 GROUP BY t.id`;

// The DB only holds committed rows, so a request still streaming shows nothing
// here. Where a live counter exists its running total wins: the dashboard must
// not lag the cap by a whole request.
export function taskRollup(db: Database.Database): TaskRollup[] {
  const rows = db.prepare(`${TASK_SQL} ORDER BY t.created_at DESC`).all() as TaskSqlRow[];
  return rows.map((row) => {
    const live = peek(row.id);
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      tokens: live === undefined ? row.tokens : live.tokens,
      usd: live === undefined ? row.usd : live.usd,
      steps: row.steps,
      estimated: row.estimated,
      unpriced: row.unpriced,
    };
  });
}

export function untrackedRollup(db: Database.Database): UntrackedRollup {
  return db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
              COALESCE(SUM(est_cost), 0) AS usd,
              COUNT(*) AS steps,
              COALESCE(SUM(estimated), 0) AS estimated,
              EXISTS (
                SELECT 1 FROM events e JOIN requests r ON r.id = e.request_id
                 WHERE r.task_id IS NULL AND e.type = 'unpriced_model'
              ) AS unpriced
         FROM requests WHERE task_id IS NULL`,
    )
    .get() as UntrackedRollup;
}

function toFeed(row: Record<string, unknown>): FeedRow {
  return {
    id: String(row.id),
    taskId: row.task_id === null ? null : String(row.task_id),
    agent: String(row.agent),
    model: String(row.model),
    ts: Number(row.ts),
    tokens: Number(row.prompt_tokens) + Number(row.completion_tokens),
    usd: Number(row.est_cost),
    status: String(row.status),
    estimated: Number(row.estimated),
    unpriced: Number(row.unpriced),
  };
}

const FEED_SQL = `
SELECT r.id, r.task_id, r.agent, r.model, r.ts, r.prompt_tokens, r.completion_tokens,
       r.est_cost, r.status, r.estimated,
       EXISTS (SELECT 1 FROM events e WHERE e.request_id = r.id AND e.type = 'unpriced_model') AS unpriced
  FROM requests r`;

export function recentRequests(db: Database.Database, limit: number): FeedRow[] {
  const rows = db
    .prepare(`${FEED_SQL} ORDER BY r.rowid DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(toFeed);
}

// Cursor by rowid, not by timestamp: two requests in the same millisecond would
// be skipped by a `ts > cursor` comparison, and insert order is what the feed is
// actually showing anyway.
export function maxRowid(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM requests').get() as { n: number };
  return row.n;
}

// Rows after the cursor, oldest first so the client prepends in order.
export function requestsSince(db: Database.Database, cursor: number, limit: number): FeedRow[] {
  const rows = db
    .prepare(`${FEED_SQL} WHERE r.rowid > ? ORDER BY r.rowid ASC LIMIT ?`)
    .all(cursor, limit) as Record<string, unknown>[];
  return rows.map(toFeed);
}

export function killTask(db: Database.Database, id: string): boolean {
  const info = db.prepare("UPDATE tasks SET status = 'killed' WHERE id = ?").run(id);
  return info.changes > 0;
}
