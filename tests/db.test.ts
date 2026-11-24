import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NoProjectError,
  createTask,
  dbPath,
  findProjectRoot,
  getTask,
  initDbPath,
  openDb,
} from '../src/store/db.js';

function freshDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), 'agentcap-db-')), 'test.db'));
}

describe('db', () => {
  it('creates the schema', () => {
    const db = freshDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['events', 'requests', 'tasks', '_migrations']));
    db.close();
  });

  it('is idempotent across opens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcap-db-'));
    const path = join(dir, 'test.db');
    openDb(path).close();
    const db = openDb(path);
    const count = db.prepare('SELECT count(*) AS n FROM _migrations').get() as { n: number };
    // One per migration file, applied exactly once across opens.
    expect(count.n).toBe(3);
    db.close();
  });

  it('uses WAL', () => {
    const db = freshDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('round-trips a task with caps', () => {
    const db = freshDb();
    const created = createTask(db, 'demo', { maxTokens: 500, maxSteps: 10, maxUsd: 1.5, maxSeconds: 60 });
    const read = getTask(db, created.id);
    expect(read).toMatchObject({
      name: 'demo',
      status: 'queued',
      max_tokens: 500,
      max_steps: 10,
      max_usd: 1.5,
      max_seconds: 60,
    });
    db.close();
  });

  it('leaves unset caps null', () => {
    const db = freshDb();
    const read = getTask(db, createTask(db, 'bare', {}).id);
    expect(read?.max_tokens).toBeNull();
    expect(read?.max_usd).toBeNull();
    db.close();
  });

  it('rejects an unknown status', () => {
    const db = freshDb();
    const task = createTask(db, 'x', {});
    expect(() => db.prepare("UPDATE tasks SET status = 'bogus' WHERE id = ?").run(task.id)).toThrow();
    db.close();
  });

  it('gives requests a monotonic seq that is not reused after a delete', () => {
    // The dashboard feed cursors on this. Plain rowid would be reused once the
    // highest row is deleted, and the cursor would silently skip rows.
    const db = freshDb();
    db.prepare(
      `INSERT INTO requests (id, task_id, agent, model, ts, status) VALUES ('a', NULL, 'x', 'm', 1, 'ok')`,
    ).run();
    db.prepare(
      `INSERT INTO requests (id, task_id, agent, model, ts, status) VALUES ('b', NULL, 'x', 'm', 2, 'ok')`,
    ).run();
    const before = db.prepare('SELECT MAX(seq) AS n FROM requests').get() as { n: number };
    db.prepare("DELETE FROM requests WHERE id = 'b'").run();
    db.prepare(
      `INSERT INTO requests (id, task_id, agent, model, ts, status) VALUES ('c', NULL, 'x', 'm', 3, 'ok')`,
    ).run();
    const after = db.prepare("SELECT seq FROM requests WHERE id = 'c'").get() as { seq: number };
    expect(after.seq).toBeGreaterThan(before.n);
    db.close();
  });

  it('defaults source to proxy and accepts otel', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO requests (id, task_id, agent, model, ts, status) VALUES ('p', NULL, 'x', 'm', 1, 'ok')`,
    ).run();
    db.prepare(
      `INSERT INTO requests (id, task_id, agent, model, ts, status, source) VALUES ('o', NULL, 'x', 'm', 2, 'ok', 'otel')`,
    ).run();
    const rows = db.prepare('SELECT id, source FROM requests ORDER BY id').all() as {
      id: string;
      source: string;
    }[];
    expect(rows).toEqual([
      { id: 'o', source: 'otel' },
      { id: 'p', source: 'proxy' },
    ]);
    db.close();
  });

  it('returns undefined for an unknown task', () => {
    const db = freshDb();
    expect(getTask(db, 'nope')).toBeUndefined();
    db.close();
  });
});

describe('db path resolution', () => {
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'agentcap-root-'));
    mkdirSync(join(root, '.agentcap'), { recursive: true });
    return root;
  }

  it('resolves the db from a nested subdirectory', () => {
    const root = project();
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
    expect(dbPath(nested)).toBe(join(root, '.agentcap', 'agentcap.db'));
  });

  it('prefers the nearest project root', () => {
    const root = project();
    const inner = join(root, 'inner');
    mkdirSync(join(inner, '.agentcap'), { recursive: true });
    expect(findProjectRoot(inner)).toBe(inner);
  });

  it('refuses when there is no project root', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentcap-bare-'));
    expect(() => findProjectRoot(bare)).toThrow(NoProjectError);
    expect(() => dbPath(bare)).toThrow(/agentcap init/);
  });

  it('init reuses the existing root rather than nesting a new one', () => {
    const root = project();
    const nested = join(root, 'deep');
    mkdirSync(nested, { recursive: true });
    expect(initDbPath(nested)).toBe(join(root, '.agentcap', 'agentcap.db'));
  });

  it('init targets where it is run when no root exists', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentcap-bare-'));
    expect(initDbPath(bare)).toBe(join(bare, '.agentcap', 'agentcap.db'));
  });
});
