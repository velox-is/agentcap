import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createDashboardServer } from '../src/ui/server.js';
import { openDb, createTask } from '../src/store/db.js';
import { startRequest, finishRequest } from '../src/store/requests.js';
import { ConfigSchema } from '../src/config.js';

const running: Server[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(running.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function boot(counts?: { prepares: number }) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentcap-tick-')), 'test.db'));
  closers.push(() => db.close());

  // Count the shared per-tick work: every taskRollup call prepares this SQL.
  if (counts !== undefined) {
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes('SELECT t.id, t.name')) counts.prepares += 1;
      return prepare(sql);
    }) as typeof db.prepare;
  }

  const config = ConfigSchema.parse({
    providers: { mock: { baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'K', models: ['m'] } },
  });
  const server = createDashboardServer({ db, config });
  running.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, db };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Opens a stream, drains the snapshot frame, then keeps reading in the
// background. Resolves once connected, with the abort controller.
async function open(base: string) {
  const ac = new AbortController();
  closers.push(() => ac.abort());
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read();
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
    }
  })().catch(() => {});
  return ac;
}

describe('dashboard broadcast', () => {
  it('runs one shared timer regardless of how many dashboards are open', async () => {
    const one = { prepares: 0 };
    const a = await boot(one);
    const aAc = await open(a.base);
    await sleep(1200);
    const withOne = one.prepares;
    aAc.abort();
    await sleep(300);

    const two = { prepares: 0 };
    const b = await boot(two);
    const b1 = await open(b.base);
    const b2 = await open(b.base);
    await sleep(1200);

    // Same wall clock, twice the clients: a per-connection timer would double
    // this. Slack for the interval boundary.
    expect(two.prepares).toBeGreaterThan(0);
    expect(two.prepares).toBeLessThan(withOne * 1.6);
    b1.abort();
    b2.abort();
  });

  it('stops the timer when the last dashboard disconnects', async () => {
    const counts = { prepares: 0 };
    const h = await boot(counts);
    const ac = await open(h.base);
    await sleep(600);
    expect(counts.prepares).toBeGreaterThan(0);

    ac.abort();
    await sleep(500);
    const afterClose = counts.prepares;
    await sleep(900);
    expect(counts.prepares).toBe(afterClose);
  });

  it('gives each client its own cursor, so both see the same new row', async () => {
    const h = await boot();
    let hits = 0;

    for (let i = 0; i < 2; i++) {
      const ac = new AbortController();
      closers.push(() => ac.abort());
      const res = await fetch(`${h.base}/api/stream`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      await reader.read();
      void (async () => {
        let buf = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buf += dec.decode(chunk.value);
          if (buf.includes('shared-row')) {
            hits += 1;
            return;
          }
        }
      })().catch(() => {});
    }

    await sleep(300);
    const task = createTask(h.db, 't', {});
    startRequest(h.db, { id: 'shared-row', taskId: task.id, agent: 'a', model: 'm', now: Date.now() });
    finishRequest(h.db, 'shared-row', {
      promptTokens: 1,
      completionTokens: 1,
      estCost: 0,
      latencyMs: 1,
      status: 'ok',
      httpStatus: 200,
      estimated: false,
    });

    await sleep(900);
    expect(hits).toBe(2);
  });
});
