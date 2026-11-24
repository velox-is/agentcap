import { createServer, request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { getTask, type TaskRow } from '../store/db.js';
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
import { Accountant, counterFor, release, type TaskCounter } from './accounting.js';
import { breachBody, isSet, terminalFrame, type BreachReason } from './verdict.js';
import { ceilingPrice, forwardHeaders, resolveProvider, upstreamUrl, MissingKeyError, UnknownModelError } from './upstream.js';

export interface ProxyDeps {
  config: Config;
  db: Database.Database;
  now?: () => number;
}

// D16: bounded polling. Kill latency stays under a quarter second without a DB
// read on every chunk of a fast stream.
const CHECK_EVERY_CHUNKS = 4;
const CHECK_EVERY_MS = 250;

// A request with no task header is tracked but uncapped, never refused. Silent
// untracked traffic is worse than visible untracked traffic.
export const UNASSIGNED = 'unassigned';

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

// Admission: everything that can refuse a request without spending upstream
// tokens. All checks live here, not in the stream loop, because a refused
// request must not burn a single token of provider budget.
//
// This is the ONLY writer of the step count. It returns the post-increment
// value and the counter takes it as given, so there is no second writer.
function admit(
  db: Database.Database,
  task: TaskRow,
  res: import('node:http').ServerResponse,
): { ok: false } | { ok: true; steps: number } {
  const refuse = (reason: BreachReason): { ok: false } => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(breachBody(task.id, reason));
    return { ok: false };
  };

  if (task.status === 'killed') return refuse('killed');
  if (task.status === 'stuck') return refuse('max_tokens');

  // Cost is incurred per request, so the ceiling is denominated in the same
  // unit: max_steps 1 permits exactly one request. Refused before the row
  // exists, so an over-limit step never reaches the provider.
  const used = taskSteps(db, task.id);
  if (isSet(task.max_steps) && used + 1 > task.max_steps) {
    addEvent(db, {
      id: randomUUID(),
      requestId: null,
      type: 'budget_breach',
      payload: { reason: 'max_steps', refusedAtAdmission: true, steps: used },
      now: Date.now(),
    });
    setStatus(db, task.id, 'stuck');
    return refuse('max_steps');
  }

  return { ok: true, steps: used + 1 };
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
  // Untracked traffic is labelled, not hidden: the dashboard needs a bucket for
  // requests that arrived with no task header (D20).
  const agent = headerValue(req.headers['x-agentcap-agent']) ?? UNASSIGNED;
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
    provider = resolveProvider(config, model, req.url ?? '/');
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

  let task: TaskRow | null = null;
  let steps = 1;
  if (taskId !== null) {
    task = getTask(db, taskId) ?? null;
    if (task === null) {
      json(res, 404, { error: 'unknown_task', task: taskId });
      return;
    }
    const admitted = admit(db, task, res);
    if (!admitted.ok) return;
    steps = admitted.steps;
  }

  startRequest(db, { id: requestId, taskId, agent, model, now: startedAt });
  if (task !== null && task.status === 'queued') setStatus(db, task.id, 'running');

  // One counter per task, seeded from the DB once while it is live. Two
  // concurrent requests on the same task share it, so neither can overshoot the
  // cap by a whole request before the other notices.
  //
  // The ceiling price is resolved once, here at admission, and frozen onto the
  // request: a per-frame lookup would let two requests price the same unknown
  // model differently in the log. A config change still applies to the next
  // request.
  const ceiling = ceilingPrice(config.pricing);
  let counter: TaskCounter | null = null;
  if (task !== null) {
    const owned = task;
    counter = counterFor(owned.id, () => {
      const totals = taskTotals(db, owned.id);
      return {
        tokens: totals.tokens,
        usd: totals.usd,
        startedAt: owned.created_at,
        steps,
        caps: {
          maxTokens: owned.max_tokens,
          maxSteps: owned.max_steps,
          maxUsd: owned.max_usd,
          maxSeconds: owned.max_seconds,
        },
        // Read from the DB every check: the kill happens in another process.
        dead: () => {
          const status = readStatus(db, owned.id);
          if (status === 'killed') return 'killed';
          if (status === 'stuck') return 'max_tokens';
          return null;
        },
      };
    });
    // Single writer: admission owns the number, the counter only reads it.
    counter.spend.steps = steps;
  }

  const accountant = new Accountant({
    shape: provider.shape,
    requestId,
    counter,
    model,
    pricing: config.pricing,
    ceilingPrice: ceiling,
    onUnpriced: (unknownModel) => {
      addEvent(db, {
        id: randomUUID(),
        requestId,
        type: 'unpriced_model',
        payload: { model: unknownModel },
        now: now(),
      });
    },
    onRegress: (info) => {
      addEvent(db, {
        id: randomUUID(),
        requestId,
        type: 'usage_regressed',
        payload: info,
        now: now(),
      });
    },
  });
  // Registered before the first frame so #sync's segment-identity assertion
  // holds from the very first call.
  if (counter !== null) counter.enter(requestId, accountant.segment);
  accountant.seedPrompt(body);

  const headers = forwardHeaders(provider, req.headers);
  const url = new URL(upstreamUrl(provider, req.url ?? '/'));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  // Settled once, on whichever path ends the request, so the registry is
  // released exactly once and siblings keep the seeded entry while they run.
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (taskId !== null) {
      counter?.leave(requestId);
      release(taskId);
    }
  };

  const upstream = send(url, { method: req.method ?? 'POST', headers, timeout: 120_000 }, (up) => {
    const status = up.statusCode ?? 502;
    const contentType = String(up.headers['content-type'] ?? '');

    // Usage in response headers is authoritative, but only where the provider
    // declared it: an undeclared `x-usage-*` header is ignored.
    if (provider.headerUsage !== null) {
      accountant.applyUsage(
        numberHeader(up.headers[provider.headerUsage.prompt]),
        numberHeader(up.headers[provider.headerUsage.completion]),
      );
    }

    if (!contentType.includes('text/event-stream')) {
      void pipeJson(res, up, { db, requestId, status, startedAt, now, accountant, settle });
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

      // Event first: a fast disconnect must not lose the record.
      if (breach !== null) {
        addEvent(db, {
          id: randomUUID(),
          requestId,
          type: breach === 'killed' ? 'task_killed' : 'budget_breach',
          payload: {
            reason: breach,
            promptTokens: final.promptTokens,
            completionTokens: final.completionTokens,
          },
          now: now(),
        });
        if (taskId !== null) setStatus(db, taskId, breach === 'killed' ? 'killed' : 'stuck');
      }

      finishRequest(db, requestId, {
        promptTokens: final.promptTokens,
        completionTokens: final.completionTokens,
        estCost: accountant.cost,
        latencyMs: now() - startedAt,
        status: requestStatus,
        httpStatus: 200,
        estimated: final.estimated,
      });

      if (breach !== null) res.write(terminalFrame(provider.shape, taskId ?? requestId, breach));
      accountant.close();
      settle();
      res.end();
      up.destroy();
    };

    up.on('data', (chunk: Buffer) => {
      if (closed) return;
      sawData = true;
      const observation = accountant.observe(chunk.toString('utf8'), now());

      // Bytes out before any verdict: the client always receives chunk N.
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
        estCost: accountant.cost,
        latencyMs: now() - startedAt,
        status: 'client_gone',
        httpStatus: 200,
        estimated: final.estimated,
      });
      accountant.close();
      settle();
      up.destroy();
    });
  });

  upstream.on('error', () => {
    if (res.headersSent) return;
    settle();
    json(res, 502, { error: 'upstream_unreachable' });
  });

  upstream.end(raw);
}

interface PipeCtx {
  db: Database.Database;
  requestId: string;
  status: number;
  startedAt: number;
  now: () => number;
  accountant: Accountant;
  settle: () => void;
}

async function pipeJson(
  res: import('node:http').ServerResponse,
  up: import('node:http').IncomingMessage,
  ctx: PipeCtx,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of up) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');

  try {
    const parsed = JSON.parse(text) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    ctx.accountant.applyUsage(
      parsed.usage?.prompt_tokens ?? null,
      parsed.usage?.completion_tokens ?? null,
    );
  } catch {
    // Non-JSON body: forward as-is, count nothing.
  }

  const final = ctx.accountant.totals;
  finishRequest(ctx.db, ctx.requestId, {
    promptTokens: final.promptTokens,
    completionTokens: final.completionTokens,
    estCost: ctx.accountant.cost,
    latencyMs: ctx.now() - ctx.startedAt,
    status: ctx.status < 400 ? 'ok' : 'upstream_error',
    httpStatus: ctx.status,
    estimated: final.estimated,
  });
  ctx.settle();

  res.writeHead(ctx.status, { 'content-type': 'application/json' });
  res.end(text);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === '' ? null : first;
}

function numberHeader(value: string | string[] | undefined): number | null {
  const raw = headerValue(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
