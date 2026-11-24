import { createServer, request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { getTask } from '../store/db.js';
import {
  addEvent,
  finishRequest,
  readStatus,
  setStatus,
  startRequest,
  taskSteps,
  taskTotals,
  type RequestStatus,
} from '../store/requests.js';
import { Accountant, breachBody, terminalFrame, type BreachReason } from './sse.js';
import { forwardHeaders, resolveProvider, upstreamUrl, MissingKeyError, UnknownModelError } from './upstream.js';

export interface ProxyDeps {
  config: Config;
  db: Database.Database;
  now?: () => number;
}

// D16: bounded polling. Kill latency stays under 250ms without a DB read on
// every chunk of a fast stream.
const CHECK_EVERY_CHUNKS = 4;
const CHECK_EVERY_MS = 250;

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createProxyServer(deps: ProxyDeps): Server {
  const now = deps.now ?? (() => Date.now());

  return createServer((req, res) => {
    const path = req.url ?? '/';

    if (path === '/health') {
      json(res, 200, { ok: true, service: 'proxy' });
      return;
    }

    void handle(deps, now, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, 500, { error: 'proxy_error', message });
    });
  });
}

async function handle(
  deps: ProxyDeps,
  now: () => number,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const { db, config } = deps;
  const startedAt = now();
  const requestId = randomUUID();
  const agent = headerValue(req.headers['x-agentcap-agent']) ?? 'unknown';
  const taskId = headerValue(req.headers['x-agentcap-task']);

  const raw = await readBody(req);
  let body: { model?: unknown; stream?: unknown };
  try {
    body = raw === '' ? {} : (JSON.parse(raw) as { model?: unknown; stream?: unknown });
  } catch {
    json(res, 400, { error: 'bad_request', message: 'body is not JSON' });
    return;
  }

  const model = typeof body.model === 'string' ? body.model : null;
  if (model === null) {
    json(res, 400, { error: 'bad_request', message: 'body has no model' });
    return;
  }

  let provider;
  try {
    provider = resolveProvider(config, model);
  } catch (err) {
    if (err instanceof UnknownModelError) {
      json(res, 400, { error: 'unknown_model', model });
      return;
    }
    if (err instanceof MissingKeyError) {
      json(res, 500, { error: 'missing_api_key', message: err.message });
      return;
    }
    throw err;
  }

  // A task that is already dead must not spend anything. Checked before the
  // request row is written so a refused request does not count as a step.
  let task = null;
  if (taskId !== null) {
    task = getTask(db, taskId) ?? null;
    if (task === null) {
      json(res, 404, { error: 'unknown_task', task: taskId });
      return;
    }
    if (task.status === 'killed' || task.status === 'stuck') {
      const reason: BreachReason = task.status === 'killed' ? 'killed' : 'max_tokens';
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(breachBody(task.id, reason));
      return;
    }
  }

  startRequest(db, { id: requestId, taskId, agent, model, now: startedAt });

  const steps = taskId === null ? 1 : taskSteps(db, taskId);
  if (task !== null && task.status === 'queued') setStatus(db, task.id, 'running');

  const totals = taskId === null ? { tokens: 0, usd: 0 } : taskTotals(db, taskId);

  const accountant = new Accountant({
    shape: provider.shape,
    taskId: taskId ?? requestId,
    caps:
      task === null
        ? {}
        : {
            maxTokens: task.max_tokens,
            maxSteps: task.max_steps,
            maxUsd: task.max_usd,
            maxSeconds: task.max_seconds,
          },
    steps,
    startedAt,
    price: provider.price,
    // Read from the DB every check: the kill happens in another process (D7).
    isDead:
      taskId === null
        ? undefined
        : () => {
            const status = readStatus(db, taskId);
            if (status === 'killed') return 'killed';
            if (status === 'stuck') return 'max_tokens';
            return null;
          },
  });
  // Prior task spend, so caps bind cumulatively rather than per request.
  accountant.seedTotals(totals.tokens, 0);
  accountant.seedPrompt(body);

  const headers = forwardHeaders(provider, req.headers as NodeJS.Dict<string>);
  const url = new URL(upstreamUrl(provider, req.url ?? '/'));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  const upstream = send(url, { method: req.method ?? 'POST', headers, timeout: 120_000 }, (up) => {
    const status = up.statusCode ?? 502;
    const contentType = String(up.headers['content-type'] ?? '');

    if (!contentType.includes('text/event-stream')) {
      void pipeJson(res, up, { db, requestId, status, startedAt, now });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();

    let chunks = 0;
    let lastCheck = startedAt;
    let closed = false;
    let sawData = false;

    const finish = (requestStatus: RequestStatus, breach: BreachReason | null): void => {
      if (closed) return;
      closed = true;
      const final = accountant.totals;

      // Event first: a fast disconnect must not lose the record (D8).
      if (breach !== null) {
        addEvent(db, {
          id: randomUUID(),
          requestId,
          type: breach === 'killed' ? 'task_killed' : 'budget_breach',
          payload: { reason: breach, promptTokens: final.promptTokens, completionTokens: final.completionTokens },
          now: now(),
        });
        if (taskId !== null) setStatus(db, taskId, breach === 'killed' ? 'killed' : 'stuck');
      }

      finishRequest(db, requestId, {
        promptTokens: final.promptTokens,
        completionTokens: final.completionTokens,
        estCost: cost(final.promptTokens, final.completionTokens, provider.price),
        latencyMs: now() - startedAt,
        status: requestStatus,
        httpStatus: 200,
        estimated: final.estimated,
      });

      if (breach !== null) res.write(terminalFrame(provider.shape, taskId ?? requestId, breach));
      accountant.close();
      res.end();
      up.destroy();
    };

    up.on('data', (chunk: Buffer) => {
      if (closed) return;
      sawData = true;
      const observation = accountant.observe(chunk.toString('utf8'), now());

      // Bytes out before any verdict: the client always receives chunk N (D8).
      for (const frame of observation.frames) res.write(frame);

      chunks += 1;
      const due = chunks % CHECK_EVERY_CHUNKS === 0 || now() - lastCheck >= CHECK_EVERY_MS;
      if (!due) return;
      lastCheck = now();

      const breach = observation.breach;
      if (breach !== null) finish(breach === 'killed' ? 'killed' : 'stuck', breach);
    });

    up.on('end', () => {
      if (closed) return;
      const tail = accountant.flush(now());
      for (const frame of tail.frames) res.write(frame);
      if (tail.breach !== null) {
        finish(tail.breach === 'killed' ? 'killed' : 'stuck', tail.breach);
        return;
      }
      // A clean close without [DONE] is a truncated stream, not success.
      finish(sawData && accountant.sawDone ? 'ok' : 'upstream_error', null);
    });

    up.on('error', () => finish('upstream_error', null));
    up.on('timeout', () => {
      up.destroy();
      finish('upstream_error', null);
    });

    res.on('close', () => {
      if (closed) return;
      closed = true;
      const final = accountant.totals;
      finishRequest(db, requestId, {
        promptTokens: final.promptTokens,
        completionTokens: final.completionTokens,
        estCost: cost(final.promptTokens, final.completionTokens, provider.price),
        latencyMs: now() - startedAt,
        status: 'client_gone',
        httpStatus: 200,
        estimated: final.estimated,
      });
      accountant.close();
      up.destroy();
    });
  });

  upstream.on('error', () => {
    if (res.headersSent) return;
    json(res, 502, { error: 'upstream_unreachable' });
  });

  upstream.end(raw);
}

async function pipeJson(
  res: import('node:http').ServerResponse,
  up: import('node:http').IncomingMessage,
  ctx: {
    db: Database.Database;
    requestId: string;
    status: number;
    startedAt: number;
    now: () => number;
  },
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of up) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');

  let usage: { prompt_tokens?: number; completion_tokens?: number } = {};
  try {
    const parsed = JSON.parse(text) as { usage?: typeof usage };
    usage = parsed.usage ?? {};
  } catch {
    // Non-JSON body: forward as-is, count nothing.
  }

  finishRequest(ctx.db, ctx.requestId, {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    estCost: 0,
    latencyMs: ctx.now() - ctx.startedAt,
    status: ctx.status < 400 ? 'ok' : 'upstream_error',
    httpStatus: ctx.status,
    estimated: usage.prompt_tokens === undefined,
  });

  res.writeHead(ctx.status, { 'content-type': 'application/json' });
  res.end(text);
}

function cost(promptTokens: number, completionTokens: number, price: { in: number; out: number } | null): number {
  if (price === null) return 0;
  return (promptTokens / 1e6) * price.in + (completionTokens / 1e6) * price.out;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === '' ? null : first;
}
