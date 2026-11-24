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
// So: one counter per task, seeded from the DB exactly once per process, and
// usage frames only ever move it by a non-negative delta.

export interface TaskSpend {
  tokens: number;
  usd: number;
  startedAt: number;
  steps: number;
  caps: Caps;
  price: { in: number; out: number } | null;
  dead: () => BreachReason | null;
}

export class TaskCounter {
  #tokens: number;
  #usd: number;
  #spend: TaskSpend;

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
}

const registry = new Map<string, TaskCounter>();

// Seeds once per task per process. Re-seeding on every request would double
// count everything already on the books.
export function counterFor(taskId: string, seed: () => TaskSpend): TaskCounter {
  const existing = registry.get(taskId);
  if (existing !== undefined) return existing;
  const created = new TaskCounter(seed());
  registry.set(taskId, created);
  return created;
}

export function forget(taskId: string): void {
  registry.delete(taskId);
}

export function resetRegistry(): void {
  registry.clear();
}

export interface AccountingOptions {
  shape: StreamShape;
  counter: TaskCounter | null;
  countText?: (text: string) => number;
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

export class Accountant {
  #parser = new SseParser();
  #opts: AccountingOptions;
  #count: (text: string) => number;
  // Request scope only, two independent floors:
  //   est*  - tokenizer counts, monotone, the floor for a provider that reports
  //           per-chunk deltas
  //   auth* - upstream usage, replaced each frame, the truth for a provider
  //           that reports cumulative totals
  // The reported number is the max of the two, so neither shape can walk the
  // count backwards and a cumulative frame cannot reset the task.
  #estPrompt = 0;
  #estCompletion = 0;
  #authPrompt = 0;
  #authCompletion = 0;
  #authoritative = false;
  #malformed = 0;
  #sawDone = false;
  #closed = false;
  #reported = 0;
  #lastCost = 0;

  constructor(opts: AccountingOptions) {
    this.#opts = opts;
    this.#count = opts.countText ?? countText;
  }

  seedPrompt(payload: unknown): void {
    if (this.#authoritative) return;
    this.#estPrompt = countValue(payload);
    this.#sync();
  }

  // Once any usage lands it wins outright: usage is the truth, the estimate is
  // only a stand-in until then. A provider that reports cumulative totals would
  // otherwise be capped by a climbing estimate that outruns the real number.
  get totals(): Totals {
    if (this.#authoritative) {
      return {
        promptTokens: this.#authPrompt,
        completionTokens: this.#authCompletion,
        estimated: false,
      };
    }
    return {
      promptTokens: this.#estPrompt,
      completionTokens: this.#estCompletion,
      estimated: true,
    };
  }

  get malformed(): number {
    return this.#malformed;
  }

  get sawDone(): boolean {
    return this.#sawDone;
  }

  observe(chunk: string, now: number = Date.now()): Observation {
    return this.#run(this.#parser.push(chunk), now);
  }

  flush(now: number = Date.now()): Observation {
    return this.#run(this.#parser.flush(), now);
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

    if (usage.text !== '') this.#estCompletion += this.#count(usage.text);
    if (usage.promptTokens !== null) {
      this.#authPrompt = usage.promptTokens;
      this.#authoritative = true;
    }
    if (usage.completionTokens !== null) {
      this.#authCompletion = usage.completionTokens;
      this.#authoritative = true;
    }
    this.#sync();
  }

  // The only place the task counter moves. Usage frames replace the request
  // total, so the task takes the positive delta and is never walked backwards
  // by a cumulative frame.
  #sync(): void {
    const counter = this.#opts.counter;
    if (counter === null) return;
    const totals = this.totals;
    const total = totals.promptTokens + totals.completionTokens;
    if (total === this.#reported) return;
    const delta = Math.max(0, total - this.#reported);
    this.#reported = total;
    counter.add(delta, this.#costDelta());
  }

  // Cost is derived from the same running numbers, so a usd cap and a token
  // cap can never disagree about what has been burned.
  #costDelta(): number {
    const price = this.#opts.counter?.spend.price ?? null;
    if (price === null) return 0;
    const totals = this.totals;
    const now = (totals.promptTokens / 1e6) * price.in + (totals.completionTokens / 1e6) * price.out;
    const delta = Math.max(0, now - this.#lastCost);
    this.#lastCost = now;
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
