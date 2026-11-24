import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, ConfigSchema, exampleConfig, loadConfig } from '../src/config.js';

function dirWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentcap-cfg-'));
  writeFileSync(join(dir, CONFIG_FILENAME), contents, 'utf8');
  return dir;
}

describe('config', () => {
  it('fills default ports', () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.ports).toEqual({ proxy: 4100, otel: 4101, dashboard: 4102 });
    expect(parsed.bind).toBe('127.0.0.1');
  });

  it('example config parses', () => {
    expect(() => ConfigSchema.parse(JSON.parse(exampleConfig()))).not.toThrow();
  });

  it('loads a valid config', async () => {
    const dir = dirWith(exampleConfig());
    const config = await loadConfig(dir);
    expect(config.ports.proxy).toBe(4100);
  });

  it('refuses 0.0.0.0', async () => {
    const dir = dirWith(JSON.stringify({ bind: '0.0.0.0' }));
    await expect(loadConfig(dir)).rejects.toThrow(/bind must be 127\.0\.0\.1/);
  });

  it('refuses duplicate ports', async () => {
    const dir = dirWith(JSON.stringify({ ports: { proxy: 4100, otel: 4100, dashboard: 4102 } }));
    await expect(loadConfig(dir)).rejects.toThrow(/distinct/);
  });

  it('rejects a provider with no models', async () => {
    const dir = dirWith(
      JSON.stringify({ providers: { x: { baseUrl: 'http://a.b', apiKeyEnv: 'K', models: [] } } }),
    );
    await expect(loadConfig(dir)).rejects.toThrow(/invalid config/);
  });

  it('reports a missing config as actionable', async () => {
    await expect(loadConfig(mkdtempSync(join(tmpdir(), 'agentcap-empty-')))).rejects.toThrow(/agentcap init/);
  });

  it('reports bad JSON', async () => {
    await expect(loadConfig(dirWith('{'))).rejects.toThrow(/not valid JSON/);
  });

  it('rejects an uppercase header usage name', async () => {
    // Node lowercases response header keys, so a mixed-case declaration would
    // silently never match. Reject at load instead.
    const dir = dirWith(
      JSON.stringify({
        providers: {
          x: {
            baseUrl: 'http://a.b',
            apiKeyEnv: 'K',
            models: ['m'],
            headerUsage: { prompt: 'X-Usage-Prompt', completion: 'x-usage-completion' },
          },
        },
      }),
    );
    await expect(loadConfig(dir)).rejects.toThrow(/lowercase/);
  });

  it('accepts a lowercase header usage pair', async () => {
    const dir = dirWith(
      JSON.stringify({
        providers: {
          x: {
            baseUrl: 'http://a.b',
            apiKeyEnv: 'K',
            models: ['m'],
            headerUsage: { prompt: 'x-usage-prompt', completion: 'x-usage-completion' },
          },
        },
      }),
    );
    const config = await loadConfig(dir);
    expect(config.providers.x?.headerUsage?.prompt).toBe('x-usage-prompt');
  });
});
