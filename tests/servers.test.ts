import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createProxyServer } from '../src/proxy/server.js';
import { createOtelServer } from '../src/otel/ingest.js';
import { createDashboardServer } from '../src/ui/server.js';
import { openDb } from '../src/store/db.js';
import { ConfigSchema, type Config } from '../src/config.js';

const running: Server[] = [];

function deps() {
  const config: Config = ConfigSchema.parse({
    providers: {
      mock: { baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'AGENTCAP_TEST_KEY', models: ['mock-1'] },
    },
  });
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentcap-srv-')), 'test.db'));
  return { config, db };
}

async function boot(server: Server): Promise<string> {
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('servers', () => {
  it('every server answers /health with its own name', async () => {
    const { config, db } = deps();
    const cases = [
      [() => createProxyServer({ config, db }), 'proxy'],
      [() => createOtelServer(), 'otel'],
      [() => createDashboardServer(), 'dashboard'],
    ] as const;
    for (const [factory, service] of cases) {
      const res = await fetch(`${await boot(factory())}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, service });
    }
    db.close();
  });

  it('dashboard serves the branded placeholder', async () => {
    const body = await (await fetch(`${await boot(createDashboardServer())}/`)).text();
    expect(body).toContain('agentcap');
    expect(body).toContain('#111111');
  });

  it('otel accepts an OTLP post', async () => {
    const res = await fetch(`${await boot(createOtelServer())}/v1/traces`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
  });

  it('otel 404s GET on an ingest path', async () => {
    const res = await fetch(`${await boot(createOtelServer())}/v1/traces`);
    expect(res.status).toBe(404);
  });
});

describe('proxy rejections', () => {
  async function proxy() {
    const d = deps();
    return { base: await boot(createProxyServer(d)), ...d };
  }

  it('400s a non-JSON body', async () => {
    const { base, db } = await proxy();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request' });
    db.close();
  });

  it('400s a body with no model', async () => {
    const { base, db } = await proxy();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request' });
    db.close();
  });

  it('400s an unconfigured model', async () => {
    const { base, db } = await proxy();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_model' });
    db.close();
  });

  it('500s a provider whose key env is unset', async () => {
    const { base, db } = await proxy();
    delete process.env.AGENTCAP_TEST_KEY;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'mock-1' }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'missing_api_key' });
    db.close();
  });

  it('404s an unknown task header', async () => {
    const { base, db } = await proxy();
    process.env.AGENTCAP_TEST_KEY = 'k';
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-agentcap-task': 'nope' },
      body: JSON.stringify({ model: 'mock-1' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'unknown_task' });
    db.close();
  });
});
