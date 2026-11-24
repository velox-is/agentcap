import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const CONFIG_FILENAME = 'agentcap.config.json';
export const EXAMPLE_FILENAME = 'agentcap.config.example.json';
export const BIND_ADDRESS = '127.0.0.1';

export const PortsSchema = z
  .object({
    proxy: z.number().int().positive(),
    otel: z.number().int().positive(),
    dashboard: z.number().int().positive(),
  })
  .default({ proxy: 4100, otel: 4101, dashboard: 4102 });

// Usage in response headers is opt-in per provider: `x-usage-*` is not
// namespaced, so any proxy in the path may set it for unrelated reasons. Absent
// means the header path never runs for this provider.
export const HeaderUsageSchema = z.object({
  prompt: z.string().min(1),
  completion: z.string().min(1),
});

export const ProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
  // Optional. Overrides path-based stream-shape detection for a proxy that
  // serves an Anthropic-compatible API off a non-anthropic host, or vice versa.
  shape: z.enum(['openai', 'anthropic']).optional(),
  headerUsage: HeaderUsageSchema.optional(),
});

export const ConfigSchema = z.object({
  bind: z.string().default(BIND_ADDRESS),
  ports: PortsSchema,
  providers: z.record(ProviderSchema).default({}),
  pricing: z
    .record(z.object({ in: z.number().nonnegative(), out: z.number().nonnegative() }))
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Ports = z.infer<typeof PortsSchema>;

export function configPath(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_FILENAME);
}

export function exampleConfig(): string {
  return `${JSON.stringify(
    {
      bind: BIND_ADDRESS,
      ports: { proxy: 4100, otel: 4101, dashboard: 4102 },
      providers: {
        'openai-compatible': {
          baseUrl: 'https://api.openai.com/v1',
          apiKeyEnv: 'OPENAI_API_KEY',
          models: ['gpt-4o-mini'],
        },
      },
      pricing: { 'gpt-4o-mini': { in: 0.15, out: 0.6 } },
    },
    null,
    2,
  )}\n`;
}

export async function writeExampleConfig(cwd: string = process.cwd()): Promise<string> {
  const path = join(cwd, EXAMPLE_FILENAME);
  await writeFile(path, exampleConfig(), 'utf8');
  return path;
}

export async function loadConfig(cwd: string = process.cwd()): Promise<Config> {
  const path = configPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`no config at ${path} — run: agentcap init`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config is not valid JSON (${path}): ${(err as Error).message}`);
  }

  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`invalid config (${path}): ${issues}`);
  }

  if (parsed.data.bind !== BIND_ADDRESS) {
    throw new Error(`bind must be ${BIND_ADDRESS} (local-first), got ${parsed.data.bind}`);
  }

  const ports = [parsed.data.ports.proxy, parsed.data.ports.otel, parsed.data.ports.dashboard];
  if (new Set(ports).size !== ports.length) {
    throw new Error(`ports must be distinct, got ${ports.join(', ')}`);
  }

  return parsed.data;
}
