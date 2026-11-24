import type Database from 'better-sqlite3';
import type { TaskRow } from './db.js';

export type RequestStatus =
  | 'streaming'
  | 'ok'
  | 'stuck'
  | 'killed'
  | 'upstream_error'
  | 'client_gone'
  | 'bad_request';

export interface RequestTotals {
  tokens: number;
  usd: number;
}

export interface FinishPatch {
  promptTokens: number;
  completionTokens: number;
  estCost: number;
  latencyMs: number;
  status: RequestStatus;
  httpStatus: number;
  estimated: boolean;
}

const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function stmt(db: Database.Database, sql: string): Database.Statement {
  let cache = statements.get(db);
  if (cache === undefined) {
    cache = new Map();
    statements.set(db, cache);
  }
  const hit = cache.get(sql);
  if (hit !== undefined) return hit;
  const prepared = db.prepare(sql);
  cache.set(sql, prepared);
  return prepared;
}

export type RequestSource = 'proxy' | 'otel';

export function startRequest(
  db: Database.Database,
  input: {
    id: string;
    taskId: string | null;
    agent: string;
    model: string;
    now: number;
    source?: RequestSource;
    status?: RequestStatus;
  },
): void {
  stmt(
    db,
    `INSERT INTO requests (id, task_id, agent, model, ts, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.taskId,
    input.agent,
    input.model,
    input.now,
    input.status ?? 'streaming',
    input.source ?? 'proxy',
  );
}

export function finishRequest(db: Database.Database, id: string, patch: FinishPatch): void {
  stmt(
    db,
    `UPDATE requests
        SET prompt_tokens = ?, completion_tokens = ?, est_cost = ?, latency_ms = ?,
            status = ?, http_status = ?, estimated = ?
      WHERE id = ?`,
  ).run(
    patch.promptTokens,
    patch.completionTokens,
    patch.estCost,
    patch.latencyMs,
    patch.status,
    patch.httpStatus,
    patch.estimated ? 1 : 0,
    id,
  );
}

export function addEvent(
  db: Database.Database,
  event: { id: string; requestId: string | null; type: string; payload: unknown; now: number },
): void {
  stmt(db, 'INSERT INTO events (id, request_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)').run(
    event.id,
    event.requestId,
    event.type,
    JSON.stringify(event.payload),
    event.now,
  );
}

// Cumulative, straight from the DB. A memory counter would drift from the
// record the dashboard shows, and the cap must bind on the same number.
export function taskTotals(db: Database.Database, taskId: string): RequestTotals {
  return stmt(
    db,
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
            COALESCE(SUM(est_cost), 0) AS usd
       FROM requests WHERE task_id = ?`,
  ).get(taskId) as RequestTotals;
}

export function taskSteps(db: Database.Database, taskId: string): number {
  const row = stmt(db, 'SELECT COUNT(*) AS n FROM requests WHERE task_id = ?').get(taskId) as {
    n: number;
  };
  return row.n;
}

export function readStatus(db: Database.Database, taskId: string): TaskRow['status'] | undefined {
  const row = stmt(db, 'SELECT status FROM tasks WHERE id = ?').get(taskId) as
    | { status: TaskRow['status'] }
    | undefined;
  return row?.status;
}

export function setStatus(db: Database.Database, taskId: string, status: TaskRow['status']): void {
  stmt(db, 'UPDATE tasks SET status = ? WHERE id = ? AND status NOT IN (?, ?)').run(
    status,
    taskId,
    'killed',
    'stuck',
  );
}
