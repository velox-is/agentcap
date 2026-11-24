import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { loadConfig, configPath, writeExampleConfig } from '../config.js';
import { openDb, dbPath, initDbPath, createTask, getTask } from '../store/db.js';
import { createProxyServer } from '../proxy/server.js';
import { createOtelServer } from '../otel/ingest.js';
import { createDashboardServer } from '../ui/server.js';
import type { Server } from 'node:http';

const USAGE = `agentcap — local-first agent observability and budget control

  agentcap init                       write config + example
  agentcap start                      boot proxy, otel, dashboard
  agentcap task new --name <n> [--max-tokens n] [--max-steps n] [--max-usd n] [--max-seconds n]
  agentcap task kill <id>
`;

function die(message: string): never {
  process.stderr.write(`agentcap: ${message}\n`);
  process.exit(1);
}

function listen(server: Server, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      try {
        assertLoopback(server, port);
      } catch (err) {
        reject(err);
        return;
      }
      process.stdout.write(`  ${label}  http://127.0.0.1:${port}\n`);
      resolve();
    });
  });
}

// Config load already refuses a non-loopback bind, but that only checks a
// string. This asserts what the kernel actually bound.
function assertLoopback(server: Server, port: number): void {
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    const got = typeof address === 'string' ? address : JSON.stringify(address);
    throw new Error(`:${port} bound to ${got} — expected 127.0.0.1`);
  }
}

async function cmdInit(): Promise<void> {
  const target = configPath();
  if (existsSync(target)) die(`${target} already exists`);
  const example = await writeExampleConfig();
  await import('node:fs/promises').then(({ writeFile }) => writeFile(target, JSON.stringify({
    bind: '127.0.0.1',
    ports: { proxy: 4100, otel: 4101, dashboard: 4102 },
    providers: {},
    pricing: {},
  }, null, 2) + '\n', 'utf8'));
  const created = initDbPath();
  openDb(created).close();
  process.stdout.write(`wrote ${target}\nwrote ${example}\ncreated ${created}\nnext: agentcap start\n`);
}

async function cmdStart(): Promise<void> {
  const config = await loadConfig();
  const db = openDb(dbPath());
  const servers = [createProxyServer({ config, db }), createOtelServer(), createDashboardServer()];

  try {
    await listen(servers[0]!, config.ports.proxy, 'proxy    ');
    await listen(servers[1]!, config.ports.otel, 'otel     ');
    await listen(servers[2]!, config.ports.dashboard, 'dashboard');
  } catch (err) {
    for (const server of servers) server.close();
    db.close();
    die(`bind failed: ${(err as Error).message}`);
  }

  process.stdout.write(`\nagentcap up — dashboard http://127.0.0.1:${config.ports.dashboard}\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    for (const server of servers) server.close();
    db.close();
    process.stdout.write('\nagentcap down\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdTaskNew(values: Record<string, unknown>): void {
  const name = values.name as string | undefined;
  if (!name) die('task new needs --name');
  const num = (key: string): number | undefined => {
    const raw = values[key] as string | undefined;
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) die(`--${key} must be a positive number`);
    return parsed;
  };
  const db = openDb(dbPath());
  const task = createTask(db, name, {
    maxTokens: num('max-tokens'),
    maxSteps: num('max-steps'),
    maxUsd: num('max-usd'),
    maxSeconds: num('max-seconds'),
  });
  db.close();
  process.stdout.write(`${task.id}\n`);
}

function cmdTaskKill(id: string): void {
  const db = openDb(dbPath());
  const task = getTask(db, id);
  if (!task) {
    db.close();
    die(`no task ${id}`);
  }
  db.prepare("UPDATE tasks SET status = 'killed' WHERE id = ?").run(id);
  db.close();
  process.stdout.write(`killed ${id}\n`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      'max-tokens': { type: 'string' },
      'max-steps': { type: 'string' },
      'max-usd': { type: 'string' },
      'max-seconds': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [command, sub, third] = positionals;

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'init') return cmdInit();
  if (command === 'start') return cmdStart();
  if (command === 'task') {
    if (sub === 'new') return cmdTaskNew(values);
    if (sub === 'kill') {
      if (!third) die('task kill needs an id');
      return cmdTaskKill(third);
    }
    die(`unknown task subcommand: ${sub ?? '(none)'}`);
  }
  if (command === 'config') {
    process.stdout.write(`${configPath()}\n`);
    return;
  }
  die(`unknown command: ${command}`);
}

await main();
