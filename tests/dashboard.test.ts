import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createDashboardServer } from '../src/ui/server.js';
import { openDb, createTask } from '../src/store/db.js';
import { startRequest, finishRequest } from '../src/store/requests.js';
import { ConfigSchema, type Config } from '../src/config.js';

const running: Server[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(running.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function config(providers: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ providers });
}

const ONE_PROVIDER = {
  mock: { baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'AGENTCAP_DASH_KEY', models: ['m'] },
};

async function boot(cfg: Config = config(ONE_PROVIDER)) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentcap-dash-')), 'test.db'));
  closers.push(() => db.close());
  const server = createDashboardServer({ db, config: cfg });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, db };
}

function insertRequest(
  db: ReturnType<typeof openDb>,
  row: { id: string; taskId: string | null; tokens: number; usd: number; estimated: number; ts: number },
) {
  startRequest(db, { id: row.id, taskId: row.taskId, agent: 'a', model: 'm', now: row.ts });
  finishRequest(db, row.id, {
    promptTokens: row.tokens,
    completionTokens: 0,
    estCost: row.usd,
    latencyMs: 5,
    status: 'ok',
    httpStatus: 200,
    estimated: row.estimated === 1,
  });
}

interface State {
  providers: number;
  tasks: {
    id: string;
    tokens: number;
    usd: number;
    steps: number;
    estimated: number;
    elapsedMs: number;
    breachReason: string | null;
    lateTokens: number;
    lateSpans: number;
  }[];
  untracked: { tokens: number; usd: number; steps: number; estimated: number; unpriced: number };
  feed: { id: string; taskId: string | null; late: number }[];
}

describe('dashboard', () => {
  it('renders the empty state and the base-URL snippet on a clean install', async () => {
    const { base } = await boot();
    const body = await (await fetch(`${base}/`)).text();
    expect(body).toContain('127.0.0.1:4100');
    expect(body).toContain('untracked');
  });

  it('shows the zero-provider banner and drops it once a provider exists', async () => {
    const none = await boot(config({}));
    const state = (await (await fetch(`${none.base}/api/state`)).json()) as State;
    expect(state.providers).toBe(0);
    expect(await (await fetch(`${none.base}/`)).text()).toContain('no providers configured');

    const some = await boot();
    expect(((await (await fetch(`${some.base}/api/state`)).json()) as State).providers).toBe(1);
  });

  it('always returns an untracked bucket, zeroed when there is no traffic', async () => {
    const { base } = await boot();
    const state = (await (await fetch(`${base}/api/state`)).json()) as State;
    expect(state.untracked).toEqual({ tokens: 0, usd: 0, steps: 0, estimated: 0, unpriced: 0 });
  });

  it('counts untracked traffic separately from every task', async () => {
    const { base, db } = await boot();
    const task = createTask(db, 'tracked', {});
    insertRequest(db, { id: 'r1', taskId: null, tokens: 40, usd: 0.002, estimated: 0, ts: Date.now() });
    insertRequest(db, { id: 'r2', taskId: task.id, tokens: 10, usd: 0.001, estimated: 0, ts: Date.now() });

    const state = (await (await fetch(`${base}/api/state`)).json()) as State;
    expect(state.untracked).toMatchObject({ tokens: 40, steps: 1 });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({ id: task.id, tokens: 10, steps: 1 });
  });

  it('carries the estimated flag through so the client can mark the number', async () => {
    const { base, db } = await boot();
    const task = createTask(db, 'estimated', {});
    insertRequest(db, { id: 'r1', taskId: task.id, tokens: 7, usd: 0, estimated: 1, ts: Date.now() });
    const state = (await (await fetch(`${base}/api/state`)).json()) as State;
    expect(state.tasks[0]?.estimated).toBe(1);
    expect(state.feed[0]).toMatchObject({ id: 'r1' });
  });

  it('carries the breach reason and the late total separately', async () => {
    const { base, db } = await boot();
    const task = createTask(db, 'capped', { maxTokens: 10 });
    // Killed on time, not on tokens: the reason must survive as-is.
    db.prepare("UPDATE tasks SET status = 'stuck', breach_reason = 'max_seconds' WHERE id = ?").run(
      task.id,
    );
    insertRequest(db, { id: 'r1', taskId: task.id, tokens: 90, usd: 0.001, estimated: 0, ts: Date.now() });
    db.prepare(
      "INSERT INTO events (id, request_id, type, payload, ts) VALUES ('e1', 'r1', 'late_usage', '{}', 1)",
    ).run();

    const state = (await (await fetch(`${base}/api/state`)).json()) as State;
    expect(state.tasks[0]).toMatchObject({
      breachReason: 'max_seconds',
      tokens: 90,
      lateTokens: 90,
      lateSpans: 1,
    });
    expect(state.feed[0]?.late).toBe(1);
  });

  it('kills a task over HTTP and reports an unknown one', async () => {
    const { base, db } = await boot();
    const task = createTask(db, 'victim', {});

    const res = await fetch(`${base}/api/tasks/${task.id}/kill`, { method: 'POST' });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(row.status).toBe('killed');

    expect((await fetch(`${base}/api/tasks/nope/kill`, { method: 'POST' })).status).toBe(404);
  });

  it('pushes a new request over SSE in under one second', async () => {
    const { base, db } = await boot();
    const task = createTask(db, 'live', {});

    const controller = new AbortController();
    closers.push(() => controller.abort());
    const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First frame is the snapshot; drain it so we are past the initial state.
    await reader.read();

    const started = Date.now();
    insertRequest(db, { id: 'live-1', taskId: task.id, tokens: 3, usd: 0, estimated: 1, ts: Date.now() });

    let seen = '';
    while (!seen.includes('live-1') && Date.now() - started < 1000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value);
    }

    expect(seen).toContain('live-1');
    expect(Date.now() - started).toBeLessThan(1000);
    controller.abort();
  });

  it('never leaks a key over /health or /api/state', async () => {
    process.env.AGENTCAP_DASH_KEY = 'super-secret-value';
    const { base } = await boot();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, service: 'dashboard' });
    const body = await (await fetch(`${base}/api/state`)).text();
    expect(body).not.toContain('super-secret-value');
    expect(body).not.toContain('AGENTCAP_DASH_KEY');
  });
});
