import { countText, countValue } from './tokens.js';
import { SseParser, classify, serialize, type ParsedFrame, type StreamShape } from './sse.js';
import { extractAnthropic, extractOpenAi, type FrameUsage } from './usage.js';
import { evaluate, type BreachReason } from './verdict.js';
import { FALLBACK_CEILING, costOf, resolvePrice, type Price } from './pricing.js';
import { advance, restartSegment, startSegment, type Segment } from './segments.js';
import type { TaskCounter } from './counter.js';

// The accountant owns request-local state only. Everything task-scoped lives in
// counter.ts and is reached exclusively through counter.add() and the verdict.
// Request arithmetic lives in segments.ts, which never sees a task total.

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
  ceilingPrice?: Price;
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

// Invariant checks are ON by default. NODE_ENV is the wrong axis for a tool run
// from `npx`, where it is usually unset: it would be on for most users by
// accident and off for exactly the people who set it. Three integer
// comparisons per frame against network latency is nothing; `--no-assert` is
// the escape hatch.
let assertsEnabled = true;

export function configureAsserts(enabled: boolean): void {
  assertsEnabled = enabled;
}

function assert(condition: boolean, message: string): void {
  if (assertsEnabled && !condition) throw new Error(`accounting invariant: ${message}`);
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
      opts.ceilingPrice ?? FALLBACK_CEILING,
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
    const resolved = resolvePrice(
      model,
      this.#opts.pricing ?? {},
      this.#opts.ceilingPrice ?? FALLBACK_CEILING,
    );
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
