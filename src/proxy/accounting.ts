import { countText, countValue } from './tokens.js';
import { SseParser, classify, serialize, type ParsedFrame, type StreamShape } from './sse.js';
import { extractAnthropic, extractOpenAi, type FrameUsage } from './usage.js';
import { evaluate, type BreachReason, type Caps } from './verdict.js';

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
// shared by every in-flight request, and only ever moved forward.

export interface TaskSpend {
  tokens: number;
  usd: number;
  startedAt: number;
  steps: number;
  caps: Caps;
  dead: () => BreachReason | null;
}

export interface Price {
  in: number;
  out: number;
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

  enter(): void {
    this.activeRequests += 1;
  }

  leave(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
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

function resolvePrice(
  model: string | null,
  pricing: Record<string, Price>,
  ceiling: Price | null,
): { price: Price | null; flagged: boolean } {
  if (model !== null) {
    const exact = pricing[model];
    if (exact !== undefined) return { price: exact, flagged: false };
  }
  // Never price an unknown model at zero: zero is an unbounded budget.
  if (ceiling !== null) return { price: ceiling, flagged: true };
  return { price: null, flagged: true };
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
  // Current pricing segment. A segment restarts on a model change or on a
  // usage regression, and each one is priced separately.
  #segBase = 0;
  #segReported = 0;
  #segCost = 0;
  #segModel: string | null;
  #segPrice: Price | null;
  #totalCost = 0;

  constructor(opts: AccountingOptions) {
    this.#opts = opts;
    this.#count = opts.countText ?? countText;
    this.#segModel = opts.model ?? null;
    const resolved = resolvePrice(this.#segModel, opts.pricing ?? {}, opts.ceilingPrice ?? null);
    this.#segPrice = resolved.price;
    if (resolved.flagged) opts.onUnpriced?.(this.#segModel);
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
    return this.#segModel;
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

    if (usage.model !== null && usage.model !== this.#segModel) this.#switchModel(usage.model);

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

  // New segment: price from here on, and treat the current request total as the
  // baseline so already-counted tokens are not counted twice.
  #switchModel(model: string): void {
    this.#segModel = model;
    const resolved = resolvePrice(model, this.#opts.pricing ?? {}, this.#opts.ceilingPrice ?? null);
    this.#segPrice = resolved.price;
    if (resolved.flagged) this.#opts.onUnpriced?.(model);
    const totals = this.totals;
    this.#segBase = totals.promptTokens + totals.completionTokens;
    this.#segReported = 0;
    // Tokens already burned are treated as paid for at the new price, so the
    // switch itself adds no cost and only later tokens are priced at it.
    const price = this.#segPrice;
    this.#segCost =
      price === null
        ? 0
        : (totals.promptTokens / 1e6) * price.in + (totals.completionTokens / 1e6) * price.out;
  }

  // Fully synchronous by design: the event loop is what makes a shared counter
  // safe without a lock. One await in here and two frames can interleave
  // mid-arithmetic.
  //
  // A decrease means the provider restarted its count (new segment, retry,
  // multi-message stream). Clamping to zero would silently discard the segment
  // and undercount, which fires the cap late. So a decrease adds the new value
  // wholesale: it can overcount on a spurious dip, which is the safe side.
  #sync(): void {
    const counter = this.#opts.counter;
    if (counter === null) return;

    const totals = this.totals;
    const requestTotal = totals.promptTokens + totals.completionTokens;
    let local = requestTotal - this.#segBase;
    const restart = local < this.#segReported;

    if (restart) {
      const previous = local;
      this.#segBase = 0;
      local = requestTotal;
      this.#segReported = 0;
      this.#segCost = 0;
      this.#opts.onRegress?.({ previous, next: requestTotal });
    }

    const delta = local - this.#segReported;
    this.#segReported = local;
    const cost = this.#segmentCost();
    if (cost > 0) this.#totalCost += cost;
    if (delta > 0 || cost > 0) counter.add(Math.max(0, delta), cost);
  }

  // Priced against the current segment's snapshot only, so a model switch
  // mid-stream cannot price old tokens at the new rate or the reverse.
  #segmentCost(): number {
    const price = this.#segPrice;
    if (price === null) return 0;
    const totals = this.totals;
    const cost =
      (totals.promptTokens / 1e6) * price.in + (totals.completionTokens / 1e6) * price.out;
    const delta = Math.max(0, cost - this.#segCost);
    this.#segCost = cost;
    return delta;
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
