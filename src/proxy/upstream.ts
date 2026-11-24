import type { Config } from '../config.js';

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  apiKey: string | null;
  shape: 'openai' | 'anthropic';
  price: { in: number; out: number } | null;
}

export class UnknownModelError extends Error {
  constructor(model: string) {
    super(`no provider serves model ${model}`);
    this.name = 'UnknownModelError';
  }
}

export class MissingKeyError extends Error {
  constructor(env: string) {
    super(`${env} is not set in the environment`);
    this.name = 'MissingKeyError';
  }
}

// Shape decides which usage fields are parsed and which terminal frame is
// emitted. The path is the honest signal (/v1/messages vs
// /v1/chat/completions); a host check breaks for an Anthropic-compatible proxy
// on a non-anthropic domain. An explicit `shape` on the provider entry wins,
// for the cases a path cannot express.
export function shapeFor(path: string, override?: 'openai' | 'anthropic'): 'openai' | 'anthropic' {
  if (override !== undefined) return override;
  return /\/messages(\?|$|\/)/.test(path) ? 'anthropic' : 'openai';
}

export function resolveProvider(config: Config, model: string, path: string): ResolvedProvider {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.models.includes(model)) continue;
    const apiKey = process.env[provider.apiKeyEnv] ?? null;
    if (apiKey === null || apiKey === '') throw new MissingKeyError(provider.apiKeyEnv);
    return {
      name,
      baseUrl: provider.baseUrl,
      apiKey,
      shape: shapeFor(path, provider.shape),
      price: config.pricing[model] ?? null,
    };
  }
  throw new UnknownModelError(model);
}

// Keep the client's own path; only the origin is replaced. An agent that
// appends /v1/messages keeps appending it.
export function upstreamUrl(provider: ResolvedProvider, path: string): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  return suffix === '' ? base : `${base}/${suffix}`;
}

// Headers that belong to agentcap and must not reach upstream: most providers
// ignore unknown headers, some 400 on them.
export function isLocalHeader(name: string): boolean {
  return name.toLowerCase().startsWith('x-agentcap-');
}

export function forwardHeaders(
  provider: ResolvedProvider,
  incoming: NodeJS.Dict<string | string[]>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
  };

  // Anthropic uses x-api-key + a mandatory version; OpenAI-compatible uses
  // bearer auth. Sending both would break neither, but the version header is
  // required, so branch rather than merge.
  if (provider.shape === 'anthropic') {
    if (provider.apiKey !== null) headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = firstValue(incoming['anthropic-version']) ?? '2023-06-01';
    const beta = firstValue(incoming['anthropic-beta']);
    if (beta !== undefined) headers['anthropic-beta'] = beta;
  } else if (provider.apiKey !== null) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }

  // Pass through anything else the client sent that is not agentcap's own, so
  // agent-specific headers survive. Hop-by-hop and framing headers do not.
  for (const [name, value] of Object.entries(incoming)) {
    if (isLocalHeader(name)) continue;
    if (name in headers) continue;
    if (name === 'host' || name === 'content-length' || name === 'connection') continue;
    const single = firstValue(value);
    if (single === undefined) continue;
    headers[name] = single;
  }

  return headers;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
