import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DB_DIR = '.agentcap';
export const DB_FILE = 'agentcap.db';

export class NoProjectError extends Error {
  constructor(start: string) {
    super(`no ${DB_DIR}/ here or in any parent of ${start} — run: agentcap init`);
    this.name = 'NoProjectError';
  }
}

// Walk up until a .agentcap/ is found, like git finds .git. Refuse otherwise:
// a silently different DB is the same failure class as an in-memory status map.
export function findProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, DB_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new NoProjectError(start);
    dir = parent;
  }
}

export function dbPath(start: string = process.cwd()): string {
  return join(findProjectRoot(start), DB_DIR, DB_FILE);
}

// init creates .agentcap/ where it is run, unless a parent already has one.
export function initDbPath(cwd: string = process.cwd()): string {
  let root: string;
  try {
    root = findProjectRoot(cwd);
  } catch {
    root = resolve(cwd);
  }
  return join(root, DB_DIR, DB_FILE);
}

function migrationsDir(): string {
  const candidates = [join(here, 'migrations'), join(here, '..', 'store', 'migrations')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`migrations directory not found (looked in ${candidates.join(', ')})`);
}

// Order matters and is not stylistic:
//
//   read pragma -> foreign_keys = OFF -> BEGIN IMMEDIATE -> ... -> COMMIT
//   -> foreign_key_check (throw on any row) -> restore the previous pragma
//
// `PRAGMA foreign_keys` is per-connection and silently ignored inside a
// transaction, so setting it after BEGIN looks correct and does nothing: the
// DROP of a referenced parent is then rejected, and only on a DB that has rows.
// `foreign_key_check` reports rather than aborts, so its result has to be
// thrown by hand. BEGIN IMMEDIATE because `task` and `init` open the same file
// and a deferred transaction can deadlock with the proxy holding the write lock.
export function migrate(db: Database.Database, dir: string = migrationsDir()): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((row) => (row as { name: string }).name),
  );
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');

    const previous = db.pragma('foreign_keys', { simple: true }) as number;
    // Outside any transaction, which is the only place it takes effect.
    db.pragma('foreign_keys = OFF');
    try {
      const apply = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
        db.pragma(`user_version = ${Number(file.slice(0, 3))}`);
      });
      apply.immediate();
    } finally {
      // Restore what the caller had, not a hardcoded ON.
      db.pragma(`foreign_keys = ${previous === 0 ? 'OFF' : 'ON'}`);
    }

    const broken = db.pragma('foreign_key_check') as unknown[];
    if (broken.length > 0) {
      throw new Error(`migration ${file} left foreign key violations: ${JSON.stringify(broken)}`);
    }
  }
}

export function openDb(path: string = dbPath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export type TaskStatus = 'queued' | 'running' | 'stuck' | 'done' | 'killed';

export interface TaskRow {
  id: string;
  name: string;
  status: TaskStatus;
  created_at: number;
  max_tokens: number | null;
  max_steps: number | null;
  max_usd: number | null;
  max_seconds: number | null;
  // Which cap fired, or 'killed'. Set once, when the task is first marked dead.
  breach_reason: string | null;
}

export interface NewTaskCaps {
  maxTokens?: number;
  maxSteps?: number;
  maxUsd?: number;
  maxSeconds?: number;
}

export function createTask(db: Database.Database, name: string, caps: NewTaskCaps): TaskRow {
  const row: TaskRow = {
    id: crypto.randomUUID(),
    name,
    status: 'queued',
    created_at: Date.now(),
    max_tokens: caps.maxTokens ?? null,
    max_steps: caps.maxSteps ?? null,
    max_usd: caps.maxUsd ?? null,
    max_seconds: caps.maxSeconds ?? null,
    breach_reason: null,
  };
  db.prepare(
    `INSERT INTO tasks (id, name, status, created_at, max_tokens, max_steps, max_usd, max_seconds)
     VALUES (@id, @name, @status, @created_at, @max_tokens, @max_steps, @max_usd, @max_seconds)`,
  ).run(row);
  return row;
}

export function getTask(db: Database.Database, id: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
}
