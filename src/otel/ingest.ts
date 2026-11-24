import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { getTask } from '../store/db.js';
import {
  addEvent,
  finishRequest,
  markDead,
  readBreachReason,
  readStatus,
  startRequest,
  taskSteps,
  taskTotals,
} from '../store/requests.js';
import { Accountant } from '../proxy/accounting.js';
import { counterFor, release, type TaskCounter } from '../proxy/counter.js';
import { exceeds, type BreachReason } from '../proxy/verdict.js';
import { ceilingPrice } from '../proxy/upstream.js';
import { mapSpans, TracePayload, type SpanRecord } from './map.js';

export interface OtelDeps {
  db: Database.Database;
  config: Config;
  now?: () => number;
}

// 1 MB. Exporters batch, but a batch is kilobytes; anything past this is a
// misconfigured sender and should be told so, not buffered.
const MAX_BODY = 1024 * 1024;

const UNASSIGNED = 'unassigned';

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY && !over) {
        over = true;
        // Keep reading so the client sees the response instead of a reset.
        chunks.length = 0;
        return;
      }
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) {
        send(res, 413, { error: 'payload_too_large', limitBytes: MAX_BODY });
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(null));
  });
}

// A span is complete when it arrives, so its usage applies whole, not as a
// delta — the accountant's authoritative-usage path is exactly that. It goes
// through the same counter as proxied traffic, so a task cannot escape a cap by
// reporting over OTel instead of the proxy.
export function applySpan(deps: OtelDeps, span: SpanRecord): void {
  const now = deps.now ?? Date.now;
  const { db, config } = deps;
  const requestId = randomUUID();
  // Backdate to the span's start so the feed orders it where it happened.
  const at = Math.max(0, now() - span.latencyMs);

  const task = span.taskId === null ? null : (getTask(db, span.taskId) ?? null);
  const taskId = task?.id ?? null;
  // A span naming an unknown task is still recorded, as untracked — losing it
  // would be worse than filing it under the wrong bucket.
  const agent = span.taskId !== null && task === null ? UNASSIGNED : span.agent;

  startRequest(db, { id: requestId, taskId, agent, model: span.model, now: at, source: 'otel' });

  let counter: TaskCounter | null = null;
  if (task !== null) {
    const owned = task;
    counter = counterFor(owned.id, () => ({
      tokens: 0,
      usd: 0,
      startedAt: owned.created_at,
      steps: 1,
      caps: {
        maxTokens: owned.max_tokens,
        maxSteps: owned.max_steps,
        maxUsd: owned.max_usd,
        maxSeconds: owned.max_seconds,
      },
      dead: () => {
        const status = readStatus(db, owned.id);
        if (status === 'killed') return 'killed';
        if (status === 'stuck') {
          return (readBreachReason(db, owned.id) as BreachReason) ?? 'max_tokens';
        }
        return null;
      },
    }));
    // Ingest is the admission writer for OTel: no request-time admission ran, so
    // the step count is taken here and handed to the counter, which never writes.
    counter.spend.steps = taskSteps(db, owned.id);
  }

  const alreadyDead = counter === null ? null : counter.spend.dead();
  const ceiling = ceilingPrice(config.pricing);

  const accountant = new Accountant({
    shape: 'openai',
    requestId,
    counter,
    model: span.model,
    pricing: config.pricing,
    ceilingPrice: ceiling,
    onUnpriced: (model) => {
      addEvent(db, {
        id: randomUUID(),
        requestId,
        type: 'unpriced_model',
        payload: { model, source: 'otel' },
        now: now(),
      });
    },
  });

  if (counter !== null) counter.enter(requestId, accountant.segment);

  accountant.applyUsage(span.promptTokens, span.completionTokens);

  const breach = accountant.observe('', now()).breach;
  const totals = accountant.totals;

  finishRequest(db, requestId, {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    estCost: accountant.cost,
    // From the span, never from ingest wall clock: a batch flushed late would
    // otherwise look like a slow request.
    latencyMs: span.latencyMs,
    status: span.failed ? 'upstream_error' : 'ok',
    httpStatus: 200,
    estimated: totals.estimated,
  });

  if (breach !== null && task !== null) {
    const deadId = task.id;
    if (alreadyDead !== null) {
      // The task was already dead when this span arrived. The spend is real, so
      // it is applied anyway and marked, never dropped. The payload answers two
      // separate questions: `reason` is why the task died (unchanged, first
      // write wins), and the rest describes the lateness itself — whether the
      // cap was accurate or whether these tokens pushed past it.
      const totalsBefore = taskTotals(db, deadId);
      const deadStatus = readStatus(db, deadId) ?? 'stuck';
      const wouldExceed =
        exceeds(
          {
            maxTokens: task.max_tokens,
            maxSteps: task.max_steps,
            maxUsd: task.max_usd,
            maxSeconds: task.max_seconds,
          },
          totalsBefore.tokens,
          totalsBefore.usd,
          taskSteps(db, deadId),
          task.created_at,
          now(),
        );
      addEvent(db, {
        id: randomUUID(),
        requestId,
        type: 'late_usage',
        payload: {
          reason: readBreachReason(db, deadId) ?? alreadyDead,
          tokens: totals.promptTokens + totals.completionTokens,
          source: 'otel',
          taskStatusAtArrival: deadStatus,
          currentVerdict: breach,
          // Ingest time minus the span's own end, so a straggler is visible as a
          // straggler rather than as a slow request. Zero when the exporter sent
          // no end timestamp, because there is nothing to measure against.
          arrivedAfterMs:
            span.endedAtMs === null ? 0 : Math.max(0, Math.round(now() - span.endedAtMs)),
          wouldExceed,
          span: span.spanId,
        },
        now: now(),
      });
    } else {
      addEvent(db, {
        id: randomUUID(),
        requestId,
        type: breach === 'killed' ? 'task_killed' : 'budget_breach',
        payload: {
          reason: breach,
          promptTokens: totals.promptTokens,
          completionTokens: totals.completionTokens,
          span: span.spanId,
        },
        now: now(),
      });
      markDead(db, deadId, breach === 'killed' ? 'killed' : 'stuck', breach);
    }
  }

  accountant.close();
  if (counter !== null && taskId !== null) {
    counter.leave(requestId);
    release(taskId);
  }
}

export function createOtelServer(deps?: OtelDeps): Server {
  return createServer(async (req, res) => {
    if (req.url === '/health') {
      send(res, 200, { ok: true, service: 'otel' });
      return;
    }

    // Logs carry no accounting meaning in v0.1; accept and ignore so an exporter
    // configured for both signals does not error.
    if (req.method === 'POST' && req.url === '/v1/logs') {
      req.resume();
      req.on('end', () => send(res, 200, { partialSuccess: {} }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/v1/traces') {
      send(res, 404, { error: 'not_found', path: req.url });
      return;
    }

    const type = String(req.headers['content-type'] ?? '');
    if (!type.includes('application/json')) {
      // Protobuf and gRPC are out of scope for v0.1; say so rather than
      // half-parsing binary.
      req.resume();
      send(res, 415, { error: 'unsupported_media_type', expected: 'application/json' });
      return;
    }

    const raw = await readBody(req, res);
    if (raw === null) return;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      send(res, 400, { error: 'bad_request', message: 'body is not JSON' });
      return;
    }

    const parsed = TracePayload.safeParse(json);
    if (!parsed.success) {
      send(res, 400, { error: 'bad_request', message: 'not an OTLP trace payload' });
      return;
    }

    let rejected = 0;
    if (deps !== undefined) {
      for (const span of mapSpans(parsed.data)) {
        try {
          applySpan(deps, span);
        } catch {
          rejected += 1;
        }
      }
    }

    // OTLP expects 200 even for partial success; the count is how the exporter
    // learns anything was dropped.
    send(
      res,
      200,
      rejected > 0 ? { partialSuccess: { rejectedSpans: String(rejected) } } : { partialSuccess: {} },
    );
  });
}
