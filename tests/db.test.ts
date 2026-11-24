import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTask, getTask, openDb } from '../src/store/db.js';

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
    expect(count.n).toBe(1);
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

  it('returns undefined for an unknown task', () => {
    const db = freshDb();
    expect(getTask(db, 'nope')).toBeUndefined();
    db.close();
  });
});
