import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, createTask } from '../src/store/db.js';
import { createProxyServer } from '../src/proxy/server.js';
import { createDashboardServer } from '../src/ui/server.js';
import { ConfigSchema } from '../src/config.js';

// End to end through real sockets: proxy traffic, then the dashboard reading the
// same DB. Unit tests cover the queries; this covers the wire.

const running: Server[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(running.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function boot() {
  // Mock upstream: one content frame, one usage frame, then [DONE].
  const up = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 4 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  running.push(up);
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const upPort = (up.address() as { port: number }).port;

  process.env.AGENTCAP_LIVE_KEY = 'k';
  const config = ConfigSchema.parse({
    providers: { mock: { baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKeyEnv: 'AGENTCAP_LIVE_KEY', models: ['m'] } },
    pricing: { m: { in: 1, out: 1 } },
  });

  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentcap-live-')), 'test.db'));
  closers.push(() => db.close());

  const proxy = createProxyServer({ config, db });
  const dash = createDashboardServer({ config, db });
  running.push(proxy, dash);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => dash.listen(0, '127.0.0.1', r));

  const proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const dashBase = `http://127.0.0.1:${(dash.address() as { port: number }).port}`;

  const send = (headers: Record<string, string> = {}) =>
    fetch(`${proxyBase}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'm', stream: true }),
    }).then((r) => r.text());

  const state = () =>
    fetch(`${dashBase}/api/state`).then((r) => r.json()) as Promise<{
      untracked: { tokens: number; steps: number };
      tasks: { id: string; tokens: number }[];
      feed: { agent: string }[];
    }>;

  return { db, dashBase, send, state };
}

describe('dashboard live', () => {
  it('separates untracked traffic from tracked, and kill stops the task', async () => {
    const h = await boot();

    const empty = await h.state();
    expect(empty.untracked.tokens).toBe(0);
    expect(empty.feed).toHaveLength(0);

    // No task header: counted as untracked, no task row invented.
    await h.send();
    const afterUntracked = await h.state();
    expect(afterUntracked.untracked).toMatchObject({ tokens: 15, steps: 1 });
    expect(afterUntracked.tasks).toHaveLength(0);

    // With a header: on the task, and newest-first in the feed.
    const task = createTask(h.db, 'live-demo', { maxTokens: 1000 });
    await h.send({ 'x-agentcap-task': task.id, 'x-agentcap-agent': 'agent-x' });
    const afterTracked = await h.state();
    expect(afterTracked.tasks.find((t) => t.id === task.id)?.tokens).toBe(15);
    expect(afterTracked.feed[0]?.agent).toBe('agent-x');

    // Kill from the UI endpoint: the proxy refuses the task at admission.
    expect((await fetch(`${h.dashBase}/api/tasks/${task.id}/kill`, { method: 'POST' })).status).toBe(200);
    const refused = await h.send({ 'x-agentcap-task': task.id });
    expect(refused).toContain('budget_exceeded');
  });

  it('pushes a new request over SSE in under one second', async () => {
    const h = await boot();
    const ac = new AbortController();
    closers.push(() => ac.abort());

    const res = await fetch(`${h.dashBase}/api/stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    const started = Date.now();
    await h.send();

    let seen = '';
    while (!seen.includes('"type":"tick"') && Date.now() - started < 1000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value);
    }

    expect(seen).toContain('"type":"tick"');
    expect(Date.now() - started).toBeLessThan(1000);
    ac.abort();
  });
});
