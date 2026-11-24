import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createProxyServer } from '../src/proxy/server.js';
import { createOtelServer } from '../src/otel/ingest.js';
import { createDashboardServer } from '../src/ui/server.js';

const running: Server[] = [];

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
    const cases = [
      [createProxyServer, 'proxy'],
      [createOtelServer, 'otel'],
      [createDashboardServer, 'dashboard'],
    ] as const;
    for (const [factory, service] of cases) {
      const base = await boot(factory());
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, service });
    }
  });

  it('dashboard serves the branded placeholder', async () => {
    const body = await (await fetch(`${await boot(createDashboardServer())}/`)).text();
    expect(body).toContain('agentcap');
    expect(body).toContain('#111111');
  });

  it('proxy 404s unknown paths', async () => {
    const res = await fetch(`${await boot(createProxyServer())}/v1/chat/completions`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
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
