import type { BreachReason, Caps } from './verdict.js';
import type { Segment } from './segments.js';

// Caps are task-scoped, so the counter is too.
//
// A per-request accumulator seeded from the DB at request start is wrong two
// ways: concurrent requests on one task each seed the same prior value and
// never see each other's live burn (so a task with N in flight can overshoot by
// roughly Nx before any of them breaches), and a cumulative usage frame
// replaces the total, which would wipe prior spend and reset the cap
// mid-stream.
//
// So: one counter per task, seeded from the DB exactly once while it is live,
// shared by every in-flight request, and only ever moved forward. Request-local
// arithmetic lives entirely in segments.ts, which never sees a task total.

export interface TaskSpend {
  tokens: number;
  usd: number;
  startedAt: number;
  steps: number;
  caps: Caps;
  dead: () => BreachReason | null;
}

export class TaskCounter {
  #tokens: number;
  #usd: number;
  #spend: TaskSpend;

  // Requests currently streaming on this task. The entry is only evicted when
  // this hits zero: evicting on breach would let in-flight siblings re-seed
  // from the DB, whose sum only holds committed rows, and keep streaming past
  // the cap.
  activeRequests = 0;
  breached = false;
  // Live segments by request id. Lets the accountant assert the segment it is
  // holding is still the one this counter knows about.
  segments = new Map<string, Segment>();

  constructor(spend: TaskSpend) {
    this.#spend = spend;
    this.#tokens = spend.tokens;
    this.#usd = spend.usd;
  }

  get tokens(): number {
    return this.#tokens;
  }

  get usd(): number {
    return this.#usd;
  }

  get spend(): TaskSpend {
    return this.#spend;
  }

  add(tokens: number, usd: number): void {
    if (tokens > 0) this.#tokens += tokens;
    if (usd > 0) this.#usd += usd;
  }

  enter(requestId: string, segment: Segment): void {
    this.activeRequests += 1;
    this.segments.set(requestId, segment);
  }

  leave(requestId: string): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.segments.delete(requestId);
  }
}

const registry = new Map<string, TaskCounter>();

// Seeds once per task while the entry is live. Re-seeding while siblings are
// streaming would double count everything already on the books.
export function counterFor(taskId: string, seed: () => TaskSpend): TaskCounter {
  const existing = registry.get(taskId);
  if (existing !== undefined) return existing;
  const created = new TaskCounter(seed());
  registry.set(taskId, created);
  return created;
}

// Called when a request finishes. Evicts only once nothing is streaming, so the
// next request re-seeds from committed rows and the map cannot leak.
export function release(taskId: string): void {
  const counter = registry.get(taskId);
  if (counter === undefined) return;
  if (counter.activeRequests === 0) registry.delete(taskId);
}

export function peek(taskId: string): TaskCounter | undefined {
  return registry.get(taskId);
}

export function resetRegistry(): void {
  registry.clear();
}
