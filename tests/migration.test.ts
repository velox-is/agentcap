import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/store/db.js';

// The migration runner is exercised against a directory the test owns, so each
// case controls exactly which files exist. Migration 002 is the one that
// recreates `requests` while `events.request_id` still references it, which is
// where a pragma ordered wrongly fails and only on a DB with rows.

const REAL = join(import.meta.dirname, '..', 'src', 'store', 'migrations');
const ONE = readFileSync(join(REAL, '001_init.sql'), 'utf8');
const TWO = readFileSync(join(REAL, '002_request_seq_and_source.sql'), 'utf8');

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'agentcap-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql, 'utf8');
  return d;
}

function seeded(files: Record<string, string>) {
  const d = dir({ '001_init.sql': ONE });
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'agentcap-migdb-')), 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, d);

  // A task, a request, and an event pointing at that request: the FK chain 002
  // has to survive.
  db.prepare("INSERT INTO tasks (id, name, status, created_at) VALUES ('t1', 'seeded', 'running', 1)").run();
  db.prepare(
    "INSERT INTO requests (id, task_id, agent, model, ts, status) VALUES ('r1', 't1', 'a', 'm', 2, 'ok')",
  ).run();
  db.prepare(
    "INSERT INTO events (id, request_id, type, payload, ts) VALUES ('e1', 'r1', 'budget_breach', '{\"reason\":\"max_usd\"}', 3)",
  ).run();
  db.prepare("UPDATE tasks SET status = 'stuck' WHERE id = 't1'").run();

  for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql, 'utf8');
  return { db, dir: d };
}

const rows = (db: Database.Database, sql: string) => db.prepare(sql).all();

describe('migration 002 and 003', () => {
  it('applies over a DB that already has events rows, keeping the FK target', () => {
    const { db, dir: d } = seeded({});
    writeFileSync(join(d, '002_request_seq_and_source.sql'), TWO, 'utf8');
    writeFileSync(
      join(d, '003_task_breach_reason.sql'),
      readFileSync(join(REAL, '003_task_breach_reason.sql'), 'utf8'),
      'utf8',
    );

    expect(() => migrate(db, d)).not.toThrow();

    // The event still resolves, and `id` survived as the FK target.
    const joined = rows(
      db,
      'SELECT e.id, r.id AS rid FROM events e JOIN requests r ON r.id = e.request_id',
    );
    expect(joined).toEqual([{ id: 'e1', rid: 'r1' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // 003 backfilled the reason from the event log, first event wins.
    const task = db.prepare("SELECT breach_reason FROM tasks WHERE id = 't1'").get() as {
      breach_reason: string | null;
    };
    expect(task.breach_reason).toBe('max_usd');

    // pragma restored to what the caller had.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('is idempotent: a second run applies nothing and stays clean', () => {
    const { db, dir: d } = seeded({});
    cpSync(REAL, d, { recursive: true, force: true });

    migrate(db, d);
    const after = rows(db, 'SELECT name FROM _migrations ORDER BY name');
    migrate(db, d);
    const again = rows(db, 'SELECT name FROM _migrations ORDER BY name');

    expect(again).toEqual(after);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('rolls back cleanly when a migration throws mid-transaction', () => {
    const { db, dir: d } = seeded({});
    // 002 with a deliberate error at the end: the drop and rename must not stick.
    writeFileSync(join(d, '002_request_seq_and_source.sql'), `${TWO}\nSELECT * FROM no_such_table;\n`, 'utf8');

    expect(() => migrate(db, d)).toThrow();

    // Original table still there, no requests_tmp, no migration recorded.
    const tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
      (r) => (r as { name: string }).name,
    );
    expect(tables).not.toContain('requests_tmp');
    expect(rows(db, 'SELECT id FROM requests')).toEqual([{ id: 'r1' }]);
    expect(rows(db, 'SELECT name FROM _migrations')).toEqual([{ name: '001_init.sql' }]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('throws on a foreign_key_check violation instead of only reporting it', () => {
    const { db, dir: d } = seeded({});
    // An orphan event: request_id pointing at nothing.
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO events (id, request_id, type, payload, ts) VALUES ('e2', 'ghost', 'x', '{}', 4)",
    ).run();
    db.pragma('foreign_keys = ON');
    writeFileSync(join(d, '002_request_seq_and_source.sql'), TWO, 'utf8');

    expect(() => migrate(db, d)).toThrow(/foreign key violations/);
    db.close();
  });

  it('restores a caller that had foreign_keys OFF', () => {
    const d = dir({ '001_init.sql': ONE });
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'agentcap-migdb-')), 'x.db'));
    db.pragma('foreign_keys = OFF');
    migrate(db, d);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(0);
    db.close();
  });
});
