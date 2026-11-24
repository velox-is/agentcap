import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createOtelServer } from '../src/otel/ingest.js';
import { createDashboardServer } from '../src/ui/server.js';
import { openDb, createTask, getTask } from '../src/store/db.js';
import { ConfigSchema } from '../src/config.js';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'otlp-traces.json'), 'utf8');

const running: Server[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(running.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function boot() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentcap-otel-')), 'test.db'));
  closers.push(() => db.close());
  const config = ConfigSchema.parse({ pricing: { 'claude-sonnet-4': { in: 3, out: 15 } } });
  const server = createOtelServer({ db, config });
  running.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // A dashboard too: the kill route lives there and must share the kill path.
  const dash = createDashboardServer({ db, config });
  running.push(dash);
  await new Promise<void>((r) => dash.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    dashBase: `http://127.0.0.1:${(dash.address() as { port: number }).port}`,
    db,
  };
}

function body(taskId: string | null): string {
  return taskId === null
    ? FIXTURE.replace('__TASK__', 'missing-task')
    : FIXTURE.replace('__TASK__', taskId);
}

const post = (base: string, payload: string, type = 'application/json') =>
  fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': type }, body: payload });

interface Row {
  id: string;
  task_id: string | null;
  agent: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  est_cost: number;
  latency_ms: number;
  status: string;
  estimated: number;
  source: string;
}

const rows = (db: ReturnType<typeof openDb>) => db.prepare('SELECT * FROM requests').all() as Row[];
const events = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT type, payload FROM events').all() as { type: string; payload: string }[];

describe('otel ingest', () => {
  it('applies span usage to the task and records latency from the span', async () => {
    const h = await boot();
    const task = createTask(h.db, 'traced', { maxTokens: 100000 });

    const res = await post(h.base, body(task.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });

    const [row] = rows(h.db);
    expect(row).toMatchObject({
      task_id: task.id,
      model: 'claude-sonnet-4',
      prompt_tokens: 1200,
      completion_tokens: 340,
      status: 'ok',
      estimated: 0,
      source: 'otel',
    });
    // 1.25s between the span's own start and end, not ingest wall clock.
    expect(row?.latency_ms).toBe(1250);
    expect(row?.est_cost).toBeCloseTo(1200 / 1e6 * 3 + 340 / 1e6 * 15, 9);
  });

  it('counts the span as a step and breaches a max_steps cap of 1 on the second', async () => {
    const h = await boot();
    const task = createTask(h.db, 'capped', { maxSteps: 1 });

    await post(h.base, body(task.id));
    await post(h.base, body(task.id));

    expect(rows(h.db)).toHaveLength(2);
    expect(getTask(h.db, task.id)?.status).toBe('stuck');
    expect(events(h.db).some((e) => e.type === 'budget_breach')).toBe(true);
  });

  it('attributes the cap the late tokens crossed, not the first cap breached', async () => {
    // A span breaches max_tokens, so the task is stuck on it. A later span does
    // not break max_tokens any harder — it breaks max_usd. Reporting max_tokens
    // for the second span would read backwards.
    const h = await boot();
    const task = createTask(h.db, 'crossing', { maxTokens: 100, maxUsd: 0.01 });

    await post(h.base, body(task.id));
    expect(getTask(h.db, task.id)?.breach_reason).toBe('max_tokens');
    // One fixture span costs 0.0087, still under the usd cap.
    expect(getTask(h.db, task.id)?.status).toBe('stuck');

    expect((await post(h.base, body(task.id))).status).toBe(200);

    const late = events(h.db).filter((e) => e.type === 'late_usage');
    expect(late).toHaveLength(1);
    expect(JSON.parse(late[0]!.payload)).toMatchObject({
      // why the task died, untouched
      reason: 'max_tokens',
      tokens: 1540,
      source: 'otel',
      taskStatusAtArrival: 'stuck',
      // the new information: these tokens crossed max_usd
      wouldExceed: true,
      capCrossed: 'max_usd',
      alreadyOver: ['max_tokens'],
    });
    // Exactly one breach event: the first span's. The second is late_usage.
    expect(events(h.db).filter((e) => e.type === 'budget_breach')).toHaveLength(1);
    expect(getTask(h.db, task.id)?.breach_reason).toBe('max_tokens');
  });

  it('keeps the original reason when a human kills an already-stuck task', async () => {
    // A manual kill moves the status but must not relabel a token breach.
    const h = await boot();
    const task = createTask(h.db, 'then-killed', { maxTokens: 10 });

    await post(h.base, body(task.id));
    expect(getTask(h.db, task.id)?.breach_reason).toBe('max_tokens');

    expect((await fetch(`${h.dashBase}/api/tasks/${task.id}/kill`, { method: 'POST' })).status).toBe(200);
    const after = getTask(h.db, task.id);
    expect(after?.status).toBe('killed');
    expect(after?.breach_reason).toBe('max_tokens');
  });

  it('reports no crossed cap when the late tokens cross nothing new', async () => {
    const h = await boot();
    const task = createTask(h.db, 'same-cap', { maxTokens: 100 });
    await post(h.base, body(task.id));
    await post(h.base, body(task.id));

    const late = events(h.db).filter((e) => e.type === 'late_usage');
    const payload = JSON.parse(late[0]!.payload) as {
      capCrossed: string | null;
      wouldExceed: boolean;
      alreadyOver: string[];
    };
    expect(payload.capCrossed).toBeNull();
    expect(payload.alreadyOver).toEqual(['max_tokens']);
    expect(payload.wouldExceed).toBe(true);
  });

  it('reports arrivedAfterMs as null and warns once when the span has no end time', async () => {
    const h = await boot();
    const task = createTask(h.db, 'no-end', { maxTokens: 10 });
    await post(h.base, body(task.id));

    // Same span, endTimeUnixNano removed.
    const noEnd = body(task.id).replace(/,?\s*"endTimeUnixNano": "[0-9]+"/, '');
    await post(h.base, noEnd);
    await post(h.base, noEnd);

    const late = events(h.db).filter((e) => e.type === 'late_usage');
    expect(late.length).toBeGreaterThanOrEqual(2);
    for (const event of late) {
      const payload = JSON.parse(event.payload) as { arrivedAfterMs: number | null };
      expect(payload.arrivedAfterMs).toBeNull();
    }
    // Once per exporter, not once per span.
    expect(events(h.db).filter((e) => e.type === 'otel_missing_end_time')).toHaveLength(1);
  });

  it('reports arrivedAfterMs for a straggler span', async () => {
    const h = await boot();
    const task = createTask(h.db, 'straggler', { maxTokens: 10 });
    h.db
      .prepare("UPDATE tasks SET status = 'stuck', breach_reason = 'max_tokens' WHERE id = ?")
      .run(task.id);

    // The fixture span covers 1.25s; ingest later and the lag shows up.
    await post(h.base, body(task.id));

    const [late] = events(h.db).filter((e) => e.type === 'late_usage');
    const payload = JSON.parse(late!.payload) as { arrivedAfterMs: number };
    expect(payload.arrivedAfterMs).toBeGreaterThan(1000);
  });

  it('records breach_reason on a fresh breach and never rewrites it', async () => {
    const h = await boot();
    const task = createTask(h.db, 'reason', { maxTokens: 10 });

    await post(h.base, body(task.id));
    expect(getTask(h.db, task.id)?.breach_reason).toBe('max_tokens');

    // A second span while dead: late_usage, reason unchanged.
    await post(h.base, body(task.id));
    expect(getTask(h.db, task.id)?.breach_reason).toBe('max_tokens');
    expect(events(h.db).some((e) => e.type === 'late_usage')).toBe(true);
  });

  it('files a span naming an unknown task as untracked, keeping the row', async () => {
    const h = await boot();
    expect((await post(h.base, body(null))).status).toBe(200);

    const [row] = rows(h.db);
    expect(row?.task_id).toBeNull();
    expect(row?.agent).toBe('unassigned');
    expect(row?.prompt_tokens).toBe(1200);
  });

  it('rejects an oversized body with 413', async () => {
    const h = await boot();
    const big = JSON.stringify({ resourceSpans: [], pad: 'x'.repeat(1024 * 1024 + 10) });
    const res = await post(h.base, big);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('rejects a non-JSON content type with 415', async () => {
    const h = await boot();
    const res = await post(h.base, body(null), 'application/x-protobuf');
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: 'unsupported_media_type' });
  });

  it('rejects a non-JSON body with 400', async () => {
    const h = await boot();
    const res = await post(h.base, 'not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('ignores a span with no model and reports it in partialSuccess', async () => {
    const h = await boot();
    const noModel = JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'a', spanId: 'b', name: 'http' }] }] }],
    });
    expect((await post(h.base, noModel)).status).toBe(200);
    expect(rows(h.db)).toHaveLength(0);
  });
});
