import { countText, countValue } from './tokens.js';
import { SseParser, classify, serialize, type ParsedFrame, type StreamShape } from './sse.js';
import { extractAnthropic, extractOpenAi, type FrameUsage } from './usage.js';
import { evaluate, type BreachReason, type Caps } from './verdict.js';
import { costOf, resolvePrice, type Price } from './pricing.js';
import { advance, restartSegment, startSegment, type Segment } from './segments.js';

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

export type { Price };

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
  // Live segments by request id. Lets #sync assert the segment it was handed is
  // still the one this counter knows about.
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

export function resetRegistry(): void {
  registry.clear();
}

export interface RegressInfo {
  previous: number;
  next: number;
}

export interface AccountingOptions {
  shape: StreamShape;
  requestId: string;
  counter: TaskCounter | null;
  model?: string | null;
  pricing?: Record<string, Price>;
  ceilingPrice?: Price | null;
  countText?: (text: string) => number;
  // Fired when a usage frame walks the counter backwards, i.e. the provider
  // restarted its count. Surfaced as an event so it is visible, not silent.
  onRegress?: (info: RegressInfo) => void;
  // Fired when a segment has no price. The segment is still priced, at the
  // highest known price, so a missing entry never costs zero.
  onUnpriced?: (model: string | null) => void;
}

export interface Totals {
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
}

export interface Observation {
  frames: string[];
  totals: Totals;
  breach: BreachReason | null;
  sawDone: boolean;
  malformed: number;
}

// Dev-only invariant checks. Silent in production: they must never throw at a
// user, but they make a refactor that breaks the accounting contract fail
// loudly in tests instead of quietly undercounting.
function assert(condition: boolean, message: string): void {
  if (!condition && process.env.NODE_ENV !== 'production') {
    throw new Error(`accounting invariant: ${message}`);
  }
}

export class Accountant {
  #parser = new SseParser();
  #opts: AccountingOptions;
  #count: (text: string) => number;
  // Per-field, and only ever overwritten by a frame that carries the field. A
  // frame with completion_tokens alone must not zero the prompt count.
  #authPrompt = 0;
  #authCompletion = 0;
  #authPromptSeen = false;
  #authCompletionSeen = false;
  // Tokenizer floors, used only for fields no usage frame has covered.
  #estPrompt = 0;
  #estCompletion = 0;
  #malformed = 0;
  #sawDone = false;
  #closed = false;
  #segment: Segment;
  #totalCost = 0;

  constructor(opts: AccountingOptions) {
    this.#opts = opts;
    this.#count = opts.countText ?? countText;
    const resolved = resolvePrice(
      opts.model ?? null,
      opts.pricing ?? {},
      opts.ceilingPrice ?? null,
    );
    this.#segment = startSegment({
      requestId: opts.requestId,
      model: opts.model ?? null,
      price: resolved.price,
      ceiling: resolved.ceiling,
    });
    if (resolved.ceiling) opts.onUnpriced?.(opts.model ?? null);
  }

  seedPrompt(payload: unknown): void {
    if (this.#authPromptSeen) return;
    this.#estPrompt = countValue(payload);
    this.#sync();
  }

  // Usage wins outright for any field it has covered. The estimate is a
  // floor-only stand-in for the rest, and it is a tokenizer guess: js-tiktoken
  // is an OpenAI tokenizer being applied to Anthropic streams too, so expect
  // 10-20% high before usage lands. Never treat it as a final number.
  get totals(): Totals {
    return {
      promptTokens: this.#authPromptSeen ? this.#authPrompt : this.#estPrompt,
      completionTokens: this.#authCompletionSeen ? this.#authCompletion : this.#estCompletion,
      estimated: !(this.#authPromptSeen && this.#authCompletionSeen),
    };
  }

  get malformed(): number {
    return this.#malformed;
  }

  get sawDone(): boolean {
    return this.#sawDone;
  }

  get model(): string | null {
    return this.#segment.model;
  }

  // The live segment object, handed to the counter on enter so #sync can assert
  // it is operating on the object that counter knows about.
  get segment(): Segment {
    return this.#segment;
  }

  // Cost accumulated by this request across every segment it spanned. Priced
  // per segment, so a model switch mid-stream is priced on both sides of the
  // switch instead of applying one rate to the whole stream.
  get cost(): number {
    return this.#totalCost;
  }

  observe(chunk: string, now: number = Date.now()): Observation {
    return this.#run(this.#parser.push(chunk), now);
  }

  // Late usage is still real usage: a trailer after the terminal frame applies
  // exactly like any other frame.
  flush(now: number = Date.now()): Observation {
    return this.#run(this.#parser.flush(), now);
  }

  // Authoritative usage that arrived before the first chunk, e.g. in a response
  // header. Applies as usage, never as an estimate.
  applyUsage(promptTokens: number | null, completionTokens: number | null): void {
    if (promptTokens !== null) {
      this.#authPrompt = promptTokens;
      this.#authPromptSeen = true;
    }
    if (completionTokens !== null) {
      this.#authCompletion = completionTokens;
      this.#authCompletionSeen = true;
    }
    this.#sync();
  }

  close(): void {
    this.#closed = true;
  }

  #run(events: ReturnType<SseParser['push']>, now: number): Observation {
    const frames: string[] = [];

    for (const event of events) {
      frames.push(serialize(event));
      const frame = classify(event);
      if (frame.kind === 'malformed') {
        this.#malformed += 1;
        continue;
      }
      if (frame.kind === 'done') {
        this.#sawDone = true;
        continue;
      }
      if (frame.kind === 'empty') continue;
      this.#absorb(frame);
    }

    return {
      frames,
      totals: this.totals,
      breach: this.#closed ? null : this.#verdict(now),
      sawDone: this.#sawDone,
      malformed: this.#malformed,
    };
  }

  #absorb(frame: ParsedFrame): void {
    const usage: FrameUsage =
      this.#opts.shape === 'openai' ? extractOpenAi(frame.payload) : extractAnthropic(frame.payload);

    if (usage.model !== null && usage.model !== this.#segment.model) this.#switchModel(usage.model);

    if (usage.text !== '') {
      if (!this.#authCompletionSeen) this.#estCompletion += this.#count(usage.text);
    }
    if (usage.promptTokens !== null) {
      this.#authPrompt = usage.promptTokens;
      this.#authPromptSeen = true;
    }
    if (usage.completionTokens !== null) {
      this.#authCompletion = usage.completionTokens;
      this.#authCompletionSeen = true;
    }
    this.#sync();
  }

  #switchModel(model: string): void {
    const resolved = resolvePrice(model, this.#opts.pricing ?? {}, this.#opts.ceilingPrice ?? null);
    if (resolved.ceiling) this.#opts.onUnpriced?.(model);
    const totals = this.totals;
    this.#segment = restartSegment(this.#segment, {
      model,
      price: resolved.price,
      ceiling: resolved.ceiling,
      requestTotal: totals.promptTokens + totals.completionTokens,
    });
    // Keep the counter's map pointing at the live segment object.
    this.#opts.counter?.segments.set(this.#segment.requestId, this.#segment);
  }

  // Fully synchronous by design: the event loop is what makes a shared counter
  // safe without a lock. One await in here and two frames can interleave
  // mid-arithmetic.
  //
  // INVARIANT: `seg.prev` is a request-local total. The task-scoped number is
  // reached only through counter.add() below, so a segment can never be walked
  // backwards by another request's burn, and a restart resets `prev` to 0 on a
  // fresh object instead of a field someone has to remember.
  #sync(): void {
    const counter = this.#opts.counter;
    if (counter === null) return;

    const seg = this.#segment;
    assert(counter.activeRequests > 0, 'sync after settle');
    assert(
      counter.segments.get(seg.requestId) === seg,
      'segment is not the live one for this request',
    );
    // A request-local `prev` can never exceed the task total, which already
    // contains every request's burn. If it does, something is task-scoped.
    assert(seg.prev <= counter.tokens, 'segment prev exceeds the task total');

    const totals = this.totals;
    const result = advance(
      seg,
      totals.promptTokens + totals.completionTokens,
      totals.promptTokens,
      totals.completionTokens,
    );
    this.#segment = result.next;
    counter.segments.set(seg.requestId, this.#segment);

    const { tokens, usd, regressed } = result.delta;
    if (regressed) {
      this.#opts.onRegress?.({ previous: seg.prev, next: this.#segment.prev });
    }
    if (usd > 0) this.#totalCost += usd;
    if (tokens > 0 || usd > 0) counter.add(tokens, usd);
  }

  #verdict(now: number): BreachReason | null {
    const counter = this.#opts.counter;
    if (counter === null) return null;
    const spend = counter.spend;
    return evaluate({
      caps: spend.caps,
      taskTokens: counter.tokens,
      taskUsd: counter.usd,
      steps: spend.steps,
      taskStartedAt: spend.startedAt,
      now,
      dead: spend.dead(),
    });
  }
}

export { costOf };
