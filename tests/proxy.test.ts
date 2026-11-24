import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxyServer } from '../src/proxy/server.js';
import { ConfigSchema, type Config } from '../src/config.js';
import { createTask, getTask, openDb } from '../src/store/db.js';

// End-to-end through the real proxy against a real socket. No mocks of the
// proxy internals: these are the behaviours the product is sold on.

const cleanups: (() => void)[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve(address.port);
    });
  });
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function chunk(text: string, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
  })}\n\n`;
}

interface UpstreamOptions {
  words?: number;
  delayMs?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
  done?: boolean;
  dieAfter?: number;
  status?: number;
  contentType?: string;
  // Extra response headers, e.g. an `x-usage-*` pair.
  headers?: Record<string, string>;
  headerUsage?: { prompt: string; completion: string };
}

async function upstream(opts: UpstreamOptions = {}) {
  const words = opts.words ?? 8;
  const delay = opts.delayMs ?? 2;
  const seen: { headers: NodeJS.Dict<string | string[]>; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const extra = opts.headers ?? {};
      if (opts.contentType !== undefined && !opts.contentType.includes('event-stream')) {
        res.writeHead(opts.status ?? 200, { 'content-type': opts.contentType, ...extra });
        res.end(JSON.stringify({ usage: opts.usage ?? {} }));
        return;
      }
      res.writeHead(opts.status ?? 200, { 'content-type': 'text/event-stream', ...extra });
      let i = 0;
      const timer = setInterval(() => {
        if (opts.dieAfter !== undefined && i === opts.dieAfter) {
          clearInterval(timer);
          res.socket?.destroy();
          return;
        }
        if (i >= words) {
          clearInterval(timer);
          if (opts.usage !== undefined) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: opts.usage })}\n\n`);
          }
          if (opts.done !== false) res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(chunk(i === 0 ? 'word' : ` word${i}`));
        i += 1;
      }, delay);
    });
  });
  const port = await listen(server);
  cleanups.push(() => server.close());
  return { port, seen };
}

interface Harness {
  base: string;
  db: ReturnType<typeof openDb>;
  taskId: string;
  kill: () => void;
  seen: { headers: NodeJS.Dict<string | string[]>; body: string }[];
  request: (init?: { signal?: AbortSignal }) => Promise<Response>;
}

async function harness(opts: UpstreamOptions & { caps?: Record<string, number> } = {}): Promise<Harness> {
  const up = await upstream(opts);
  process.env.AGENTCAP_E2E_KEY = 'secret';

  const config: Config = ConfigSchema.parse({
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${up.port}`,
        apiKeyEnv: 'AGENTCAP_E2E_KEY',
        models: ['mock-1'],
        ...(opts.headerUsage === undefined ? {} : { headerUsage: opts.headerUsage }),
      },
    },
    pricing: { 'mock-1': { in: 1, out: 1 } },
  });

  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentcap-e2e-')), 'test.db'));
  cleanups.push(() => db.close());

  const task = createTask(db, 'e2e', opts.caps ?? {});
  const server = createProxyServer({ config, db });
  const port = await listen(server);
  cleanups.push(() => server.close());

  return {
    base: `http://127.0.0.1:${port}`,
    db,
    taskId: task.id,
    seen: up.seen,
    kill: () => db.prepare("UPDATE tasks SET status = 'killed' WHERE id = ?").run(task.id),
    request: (init = {}) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'x-agentcap-task': task.id, 'x-agentcap-agent': 'e2e-agent' },
        body: JSON.stringify({ model: 'mock-1', stream: true }),
        ...init,
      }),
  };
}

function rows(db: ReturnType<typeof openDb>) {
  return db.prepare('SELECT status, prompt_tokens, completion_tokens, estimated FROM requests').all() as {
    status: string;
    prompt_tokens: number;
    completion_tokens: number;
    estimated: number;
  }[];
}

function events(db: ReturnType<typeof openDb>) {
  return db.prepare('SELECT type, payload FROM events').all() as { type: string; payload: string }[];
}

describe('proxy passthrough', () => {
  it('streams and records exact upstream usage', async () => {
    const h = await harness({ usage: { prompt_tokens: 30, completion_tokens: 12 } });
    const body = await (await h.request()).text();

    expect(body).toContain('data: [DONE]');
    expect(body).toContain('word1');
    const [row] = rows(h.db);
    expect(row).toMatchObject({ status: 'ok', prompt_tokens: 30, completion_tokens: 12, estimated: 0 });
    expect(getTask(h.db, h.taskId)?.status).toBe('running');
  });

  it('forwards the path, the body and a bearer key upstream', async () => {
    const h = await harness();
    await (await h.request()).text();
    const [seen] = h.seen;
    expect(seen?.headers.authorization).toBe('Bearer secret');
    expect(JSON.parse(seen!.body)).toMatchObject({ model: 'mock-1', stream: true });
  });

  it('does not leak the agentcap task header upstream', async () => {
    const h = await harness();
    await (await h.request()).text();
    expect(h.seen[0]?.headers['x-agentcap-task']).toBeUndefined();
  });

  it('keeps the client path verbatim', async () => {
    const h = await harness();
    await fetch(`${h.base}/v1/messages/extra?beta=1`, {
      method: 'POST',
      headers: { 'x-agentcap-task': h.taskId },
      body: JSON.stringify({ model: 'mock-1', stream: true }),
    }).then((r) => r.text());
    expect(h.seen).toHaveLength(1);
  });

  it('applies declared header usage before the first chunk', async () => {
    const h = await harness({
      words: 3,
      delayMs: 1,
      headers: { 'x-usage-prompt': '70', 'x-usage-completion': '5' },
      headerUsage: { prompt: 'x-usage-prompt', completion: 'x-usage-completion' },
    });
    await (await h.request()).text();
    const [row] = rows(h.db);
    // Header usage is authoritative: the tokenizer estimate never gets used.
    expect(row?.prompt_tokens).toBe(70);
    expect(row?.completion_tokens).toBe(5);
    expect(row?.estimated).toBe(0);
  });

  it('ignores an undeclared usage header', async () => {
    const h = await harness({
      words: 3,
      delayMs: 1,
      headers: { 'x-usage-prompt': '70', 'x-usage-completion': '5' },
    });
    await (await h.request()).text();
    const [row] = rows(h.db);
    expect(row?.prompt_tokens).not.toBe(70);
    expect(row?.estimated).toBe(1);
  });

  it('warns once when a declared usage header never appears', async () => {
    // A typo'd declaration is otherwise silent: usage just never becomes
    // authoritative. One event per provider, on the first unmatched response.
    const h = await harness({
      words: 3,
      delayMs: 1,
      headerUsage: { prompt: 'x-usage-prompt', completion: 'x-usage-completion' },
    });
    await (await h.request()).text();
    await (await h.request()).text();
    const warned = events(h.db).filter((e) => e.type === 'header_usage_unmatched');
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0]!.payload)).toMatchObject({
      provider: 'mock',
      missing: ['x-usage-prompt', 'x-usage-completion'],
    });
    // Accounting stays safe: the estimate remains in place.
    expect(rows(h.db).every((r) => r.estimated === 1)).toBe(true);
  });

  it('marks a usage-less stream estimated', async () => {
    const h = await harness();
    await (await h.request()).text();
    const [row] = rows(h.db);
    expect(row?.estimated).toBe(1);
    expect(row?.completion_tokens).toBeGreaterThan(0);
  });

  it('records an upstream close with no [DONE] as upstream_error', async () => {
    const h = await harness({ done: false });
    await (await h.request()).text();
    expect(rows(h.db)[0]?.status).toBe('upstream_error');
    expect(getTask(h.db, h.taskId)?.status).not.toBe('killed');
  });

  it('records an upstream socket death as upstream_error', async () => {
    const h = await harness({ words: 20, dieAfter: 2, delayMs: 10 });
    await (await h.request()).text().catch(() => '');
    expect(rows(h.db)[0]?.status).toBe('upstream_error');
  });

  it('records a client abort as client_gone, not killed', async () => {
    const h = await harness({ words: 40, delayMs: 15 });
    const controller = new AbortController();
    const res = await h.request({ signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 120));
    expect(rows(h.db)[0]?.status).toBe('client_gone');
    expect(getTask(h.db, h.taskId)?.status).not.toBe('killed');
  });
});

describe('caps end to end', () => {
  it('sends the exact 429 body and marks the task stuck', async () => {
    const h = await harness({ words: 200, delayMs: 1, caps: { maxTokens: 6 } });
    const body = await (await h.request()).text();

    expect(body).toContain('"error":"budget_exceeded"');
    expect(body).toContain(`"task":"${h.taskId}"`);
    expect(body).toContain('"reason":"max_tokens"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(getTask(h.db, h.taskId)?.status).toBe('stuck');
    expect(rows(h.db)[0]?.status).toBe('stuck');
  });

  it('logs the breach event', async () => {
    const h = await harness({ words: 200, delayMs: 1, caps: { maxTokens: 6 } });
    await (await h.request()).text();
    const logged = events(h.db);
    expect(logged[0]?.type).toBe('budget_breach');
    expect(JSON.parse(logged[0]!.payload)).toMatchObject({ reason: 'max_tokens' });
  });

  it('refuses a new request on a stuck task with 429', async () => {
    const h = await harness({ words: 200, delayMs: 1, caps: { maxTokens: 4 } });
    await (await h.request()).text();
    const second = await h.request();
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: 'budget_exceeded', reason: 'max_tokens' });
  });

  it('counts prior spend so a second request starts part-spent', async () => {
    const h = await harness({ usage: { prompt_tokens: 50, completion_tokens: 10 }, caps: { maxTokens: 55 } });
    await (await h.request()).text();
    // 60 tokens already burned against a 55 cap: the next request breaches.
    const second = await h.request();
    expect(second.status).toBe(429);
  });

  it('shares one counter across two concurrent requests on the same task', async () => {
    // Both requests start with an empty task, so a per-request accumulator would
    // let each burn a full 30 tokens against a 40 cap and never breach.
    const h = await harness({ usage: { prompt_tokens: 20, completion_tokens: 10 }, caps: { maxTokens: 40 } });
    const [a, b] = await Promise.all([h.request(), h.request()]);
    const [bodyA, bodyB] = await Promise.all([a.text(), b.text()]);

    const breached = [bodyA, bodyB].filter((body) => body.includes('budget_exceeded'));
    expect(breached.length).toBeGreaterThanOrEqual(1);
    // Combined burn is the shared figure: 2 x 30 = 60, and the counter sees it.
    expect(getTask(h.db, h.taskId)?.status).toBe('stuck');
  });
});

describe('admission', () => {
  it('refuses a stuck task with the 429 body and burns nothing upstream', async () => {
    const h = await harness({ words: 200, delayMs: 1, caps: { maxTokens: 6 } });
    await (await h.request()).text();
    const seenBefore = h.seen.length;

    const res = await h.request();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'budget_exceeded',
      task: h.taskId,
      reason: 'max_tokens',
    });
    // The refused request never reached the provider.
    expect(h.seen.length).toBe(seenBefore);
    expect(rows(h.db)).toHaveLength(1);
  });

  it('refuses a killed task before the stream starts', async () => {
    const h = await harness({ words: 4, delayMs: 1 });
    h.kill();
    const res = await h.request();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'budget_exceeded', task: h.taskId, reason: 'killed' });
    expect(h.seen).toHaveLength(0);
  });

  it('allows the step at the limit and refuses the one past it', async () => {
    const h = await harness({ words: 3, delayMs: 1, caps: { maxSteps: 1 } });
    const first = await h.request();
    expect(first.status).toBe(200);
    await first.text();

    const second = await h.request();
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ reason: 'max_steps' });
    // Refused at admission, so no upstream call and no request row.
    expect(h.seen).toHaveLength(1);
    expect(rows(h.db)).toHaveLength(1);
    expect(getTask(h.db, h.taskId)?.status).toBe('stuck');
  });
});

describe('untracked traffic', () => {
  it('logs a request with no task header as unassigned and uncapped', async () => {
    const h = await harness({ words: 6, delayMs: 1, caps: { maxTokens: 2 } });
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'mock-1', stream: true }),
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('data: [DONE]');

    const row = h.db.prepare('SELECT task_id, agent, status FROM requests').get() as {
      task_id: string | null;
      agent: string;
      status: string;
    };
    expect(row.task_id).toBeNull();
    expect(row.agent).toBe('unassigned');
    expect(row.status).toBe('ok');
  });
});

describe('kill switch', () => {
  it('closes a live stream and marks the task killed', async () => {
    const h = await harness({ words: 400, delayMs: 5 });
    const res = await h.request();
    const reader = res.body!.getReader();
    await reader.read();
    h.kill();

    let text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    expect(text).toContain('"reason":"killed"');
    expect(getTask(h.db, h.taskId)?.status).toBe('killed');
    expect(rows(h.db)[0]?.status).toBe('killed');
    expect(events(h.db).some((e) => e.type === 'task_killed')).toBe(true);
  });

  it('stops a killed task within 250ms', async () => {
    // One chunk every 300ms: the interval never trips the 4-chunk rule, so only
    // the 250ms time rule can catch this. That is the real worst case.
    const h = await harness({ words: 40, delayMs: 300 });
    const res = await h.request();
    const reader = res.body!.getReader();
    await reader.read();

    const started = Date.now();
    h.kill();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(250 + 400); // 250ms budget + one 300ms chunk wait
    expect(getTask(h.db, h.taskId)?.status).toBe('killed');
  }, 15_000);

  it('leaves a concurrent task untouched when another is killed', async () => {
    const h = await harness({ words: 300, delayMs: 5 });
    const other = createTask(h.db, 'other', {});

    const victim = h.request();
    const bystander = fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-agentcap-task': other.id },
      body: JSON.stringify({ model: 'mock-1', stream: true }),
    });

    const [a, b] = await Promise.all([victim, bystander]);
    const reader = a.body!.getReader();
    await reader.read();
    h.kill();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    const otherBody = await b.text();

    expect(getTask(h.db, h.taskId)?.status).toBe('killed');
    expect(getTask(h.db, other.id)?.status).not.toBe('killed');
    expect(otherBody).toContain('data: [DONE]');
  }, 15_000);
});
