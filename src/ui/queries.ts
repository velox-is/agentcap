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
  // Which cap fired, or 'killed'. The reason a task stopped, as distinct from
  // the verdict currently true of it.
  breachReason: string | null;
  // Tokens that arrived after the task was already dead, and how many spans
  // they came in on. Both numbers matter: a task capped at 400 tokens that
  // reports 3,000 late looks fine on the first number alone.
  lateTokens: number;
  lateSpans: number;
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
  // This row's usage arrived after its task was already dead, and how late it
  // was in ms. `late` is 0/1; `lateAfterMs` is null when the exporter sent no
  // end timestamp, which is a different fact from 0.
  late: number;
  lateAfterMs: number | null;
}

interface TaskSqlRow {
  id: string;
  name: string;
  status: string;
  created_at: number;
  breach_reason: string | null;
  tokens: number;
  usd: number;
  steps: number;
  estimated: number;
  unpriced: number;
  late_tokens: number;
  late_spans: number;
}

const TASK_SQL = `
SELECT t.id, t.name, t.status, t.created_at, t.breach_reason,
       COALESCE(SUM(r.prompt_tokens + r.completion_tokens), 0) AS tokens,
       COALESCE(SUM(r.est_cost), 0) AS usd,
       COUNT(r.id) AS steps,
       COALESCE(SUM(r.estimated), 0) AS estimated,
       EXISTS (
         SELECT 1 FROM events e JOIN requests r2 ON r2.id = e.request_id
          WHERE r2.task_id = t.id AND e.type = 'unpriced_model'
       ) AS unpriced,
       COALESCE(SUM(CASE WHEN EXISTS (
         SELECT 1 FROM events e WHERE e.request_id = r.id AND e.type = 'late_usage'
       ) THEN r.prompt_tokens + r.completion_tokens ELSE 0 END), 0) AS late_tokens,
       COALESCE(SUM(CASE WHEN EXISTS (
         SELECT 1 FROM events e WHERE e.request_id = r.id AND e.type = 'late_usage'
       ) THEN 1 ELSE 0 END), 0) AS late_spans
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
      breachReason: row.breach_reason,
      lateTokens: row.late_tokens,
      lateSpans: row.late_spans,
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
    late: Number(row.late),
    lateAfterMs: row.late_after_ms === null ? null : Number(row.late_after_ms),
  };
}

const FEED_SQL = `
SELECT r.seq, r.id, r.task_id, r.agent, r.model, r.ts, r.prompt_tokens, r.completion_tokens,
       r.est_cost, r.status, r.estimated,
       EXISTS (SELECT 1 FROM events e WHERE e.request_id = r.id AND e.type = 'unpriced_model') AS unpriced,
       EXISTS (SELECT 1 FROM events e WHERE e.request_id = r.id AND e.type = 'late_usage') AS late,
       (SELECT json_extract(e.payload, '$.arrivedAfterMs') FROM events e
         WHERE e.request_id = r.id AND e.type = 'late_usage' LIMIT 1) AS late_after_ms
  FROM requests r`;

export function recentRequests(db: Database.Database, limit: number): FeedRow[] {
  const rows = db
    .prepare(`${FEED_SQL} ORDER BY r.seq DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(toFeed);
}

// Cursor by `seq`, not by timestamp and not by rowid. A timestamp cursor skips
// two requests in the same millisecond; a rowid cursor skips rows as soon as
// anything deletes the highest one, because plain rowid is reused. `seq` is
// INTEGER PRIMARY KEY AUTOINCREMENT, so it never goes backwards.
export function maxSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM requests').get() as { n: number };
  return row.n;
}

// Rows after the cursor, oldest first so the client prepends in order.
export function requestsSince(db: Database.Database, cursor: number, limit: number): FeedRow[] {
  const rows = db
    .prepare(`${FEED_SQL} WHERE r.seq > ? ORDER BY r.seq ASC LIMIT ?`)
    .all(cursor, limit) as Record<string, unknown>[];
  return rows.map(toFeed);
}

// Rows that finished but whose feed entry the client still holds as
// `streaming`. The feed is built from inserts, so without this a completed
// request would read "streaming" forever. Bounded to the window the client
// keeps and merged by id there, so re-sending is harmless.
export function settledRequests(db: Database.Database, floor: number, limit: number): FeedRow[] {
  const rows = db
    .prepare(`${FEED_SQL} WHERE r.seq > ? AND r.status != 'streaming' ORDER BY r.seq ASC LIMIT ?`)
    .all(floor, limit) as Record<string, unknown>[];
  return rows.map(toFeed);
}

// Re-exported rather than reimplemented: the dashboard kill and `task kill` must
// take the same path, including the first-write-wins breach_reason, or a click
// would relabel a token breach as a manual kill.
export { killTask } from '../store/requests.js';
