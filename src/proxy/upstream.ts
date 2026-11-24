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

// The base URL shape is the only honest signal available: Anthropic streams
// event-typed frames, everything else here is OpenAI-compatible. It changes
// which usage fields are parsed and which terminal frame is emitted, so it is
// derived once, here, rather than sniffed per chunk.
function shapeOf(baseUrl: string): 'openai' | 'anthropic' {
  return /anthropic\.com/.test(baseUrl) ? 'anthropic' : 'openai';
}

export function resolveProvider(config: Config, model: string): ResolvedProvider {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.models.includes(model)) continue;
    const apiKey = process.env[provider.apiKeyEnv] ?? null;
    if (apiKey === null || apiKey === '') throw new MissingKeyError(provider.apiKeyEnv);
    return {
      name,
      baseUrl: provider.baseUrl,
      apiKey,
      shape: shapeOf(provider.baseUrl),
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

export function forwardHeaders(
  provider: ResolvedProvider,
  incoming: NodeJS.Dict<string>,
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
    headers['anthropic-version'] = incoming['anthropic-version'] ?? '2023-06-01';
    const beta = incoming['anthropic-beta'];
    if (beta !== undefined) headers['anthropic-beta'] = beta;
  } else if (provider.apiKey !== null) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }

  return headers;
}
