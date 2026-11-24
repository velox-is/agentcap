import { z } from 'zod';
import { countText, countValue } from './tokens.js';

// THE CRITICAL FILE. Nothing downstream can be trusted if this lies.
//
// Three separate jobs, deliberately in this order and never merged:
//   1. framing      - split the wire into SSE events, survive any chunk split
//   2. accounting   - authoritative usage when upstream sends it, estimate otherwise
//   3. cap decision - compare running totals, decide "close after this frame"
//
// The passthrough forwards the verbatim bytes of every frame in `frames`, so
// the client sees exactly what upstream sent, at the moment it arrives.

export type StreamShape = 'openai' | 'anthropic';

export interface SseEvent {
  id: string | null;
  event: string | null;
  data: string;
}

export class SseParser {
  #buffer = '';
  #current: SseEvent | null = null;

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const events: SseEvent[] = [];

    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.#buffer);
      if (match === null) break;
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const finished = this.#consumeLine(line);
      if (finished !== null) events.push(finished);
    }

    return events;
  }

  // Anything left in the buffer when upstream closes. A trailing line without
  // a blank-line terminator is still a real event; dropping it loses tokens.
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    const rest = this.#buffer;
    this.#buffer = '';
    if (rest !== '') {
      const finished = this.#consumeLine(rest);
      if (finished !== null) events.push(finished);
    }
    const trailing = this.#takePending();
    if (trailing !== null) events.push(trailing);
    return events;
  }

  #takePending(): SseEvent | null {
    const pending = this.#current;
    this.#current = null;
    return pending;
  }

  // Returns the event this line terminated, if any. A blank line ends the
  // current event; any other line either starts or extends it.
  #consumeLine(line: string): SseEvent | null {
    if (line === '') return this.#takePending();
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    this.#current ??= { id: null, event: null, data: '' };
    if (field === 'data') {
      this.#current.data = this.#current.data === '' ? value : `${this.#current.data}\n${value}`;
    } else if (field === 'event') {
      this.#current.event = value;
    } else if (field === 'id') {
      this.#current.id = value;
    }
    return null;
  }
}

export type FrameKind = 'json' | 'done' | 'malformed' | 'empty';

export interface ParsedFrame {
  event: string | null;
  kind: FrameKind;
  payload: unknown;
}

export function classify(event: SseEvent): ParsedFrame {
  const trimmed = event.data.trim();
  if (trimmed === '') return { event: event.event, kind: 'empty', payload: null };
  if (trimmed === '[DONE]') return { event: event.event, kind: 'done', payload: null };
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return { event: event.event, kind: 'malformed', payload: trimmed };
  }
  return { event: event.event, kind: 'json', payload };
}

// --- boundary validation. No `any`; every field the counter reads is checked.

const OpenAiUsage = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
});

const OpenAiChunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({ content: z.string().nullish(), reasoning_content: z.string().nullish() })
          .nullish(),
      }),
    )
    .nullish(),
  usage: OpenAiUsage.nullish(),
});

const AnthropicUsageStart = z.object({
  input_tokens: z.number().nonnegative(),
  cache_read_input_tokens: z.number().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().nonnegative().nullish(),
});

const AnthropicFrame = z.object({
  type: z.string(),
  message: z.object({ usage: AnthropicUsageStart.nullish() }).nullish(),
  usage: z.object({ output_tokens: z.number().nonnegative().nullish() }).nullish(),
  delta: z
    .object({
      text: z.string().nullish(),
      thinking: z.string().nullish(),
      partial_json: z.string().nullish(),
    })
    .nullish(),
});

export type BreachReason = 'max_tokens' | 'max_steps' | 'max_usd' | 'max_seconds' | 'killed';

export interface Caps {
  maxTokens?: number | null;
  maxSteps?: number | null;
  maxUsd?: number | null;
  maxSeconds?: number | null;
}

export interface AccountantOptions {
  shape: StreamShape;
  taskId: string;
  caps: Caps;
  steps: number;
  startedAt: number;
  price?: { in: number; out: number } | null;
  // Returns the reason the task is already dead, or null. A stuck task and a
  // killed task are both terminal but must not be reported as each other.
  isDead?: () => BreachReason | null;
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

// Anthropic reports cumulative output_tokens, OpenAI reports one terminal
// usage chunk. Neither is a per-chunk delta, so usage always replaces, never
// sums. During streaming the estimate keeps climbing; the moment real usage
// lands it overwrites the estimate and estimated flips to false.
export class Accountant {
  #parser = new SseParser();
  #opts: AccountantOptions;
  #count: (text: string) => number;
  #promptTokens = 0;
  #completionTokens = 0;
  #estimated = true;
  #authoritativeInput = false;
  #malformed = 0;
  #sawDone = false;
  #closed = false;

  constructor(opts: AccountantOptions) {
    this.#opts = opts;
    this.#count = opts.countText ?? countText;
  }

  seedPrompt(payload: unknown): void {
    if (this.#authoritativeInput) return;
    this.#promptTokens = countValue(payload);
  }

  // Caps are cumulative across the whole task, so prior spend is loaded in
  // before the first chunk. Without this every request gets a fresh budget.
  seedTotals(promptTokens: number, completionTokens: number): void {
    this.#promptTokens += promptTokens;
    this.#completionTokens += completionTokens;
  }

  get totals(): Totals {
    return {
      promptTokens: this.#promptTokens,
      completionTokens: this.#completionTokens,
      estimated: this.#estimated,
    };
  }

  get malformed(): number {
    return this.#malformed;
  }

  get sawDone(): boolean {
    return this.#sawDone;
  }

  // Frames come back verbatim and in arrival order, before any cap verdict is
  // acted on: the client gets chunk N, then the socket closes.
  observe(chunk: string, now: number = Date.now()): Observation {
    return this.#run(this.#parser.push(chunk), now);
  }

  flush(now: number = Date.now()): Observation {
    return this.#run(this.#parser.flush(), now);
  }

  close(): void {
    this.#closed = true;
  }

  #run(events: SseEvent[], now: number): Observation {
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
    if (this.#opts.shape === 'openai') {
      const parsed = OpenAiChunk.safeParse(frame.payload);
      if (!parsed.success) return;
      const delta = parsed.data.choices?.[0]?.delta;
      const text = delta?.content ?? delta?.reasoning_content ?? '';
      if (text !== '') this.#completionTokens += this.#count(text);
      const usage = parsed.data.usage;
      if (usage != null) this.#authoritative(usage.prompt_tokens, usage.completion_tokens);
      return;
    }

    const parsed = AnthropicFrame.safeParse(frame.payload);
    if (!parsed.success) return;
    const body = parsed.data;

    if (body.type === 'message_start') {
      const usage = body.message?.usage;
      if (usage != null) {
        this.#authoritativeInput = true;
        this.#promptTokens =
          usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        this.#estimated = false;
      }
      return;
    }

    if (body.type === 'content_block_delta') {
      const text = body.delta?.text ?? body.delta?.thinking ?? body.delta?.partial_json ?? '';
      if (text !== '') this.#completionTokens += this.#count(text);
      return;
    }

    if (body.type === 'message_delta') {
      const out = body.usage?.output_tokens;
      if (out != null) {
        this.#completionTokens = out;
        this.#estimated = false;
      }
    }
  }

  #authoritative(prompt: number, completion: number): void {
    this.#promptTokens = prompt;
    this.#completionTokens = completion;
    this.#estimated = false;
  }

  #cost(): number {
    const price = this.#opts.price;
    if (price == null) return 0;
    return (this.#promptTokens / 1e6) * price.in + (this.#completionTokens / 1e6) * price.out;
  }

  #verdict(now: number): BreachReason | null {
    const dead = this.#opts.isDead?.() ?? null;
    if (dead !== null) return dead;
    const caps = this.#opts.caps;
    const total = this.#promptTokens + this.#completionTokens;

    // `> 0` not just `!= null`: a stored 0 means "present but unset", and
    // `0 != null` is true, which would make every task breach on frame one.
    if (caps.maxTokens != null && caps.maxTokens > 0 && total >= caps.maxTokens) return 'max_tokens';
    if (caps.maxSteps != null && caps.maxSteps > 0 && this.#opts.steps > caps.maxSteps) {
      return 'max_steps';
    }
    if (caps.maxUsd != null && caps.maxUsd > 0 && this.#cost() >= caps.maxUsd) return 'max_usd';
    if (caps.maxSeconds != null && caps.maxSeconds > 0 && now - this.#opts.startedAt >= caps.maxSeconds * 1000) {
      return 'max_seconds';
    }
    return null;
  }
}

function serialize(event: SseEvent): string {
  let out = '';
  if (event.id !== null) out += `id: ${event.id}\n`;
  if (event.event !== null) out += `event: ${event.event}\n`;
  for (const line of event.data.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

export function breachBody(taskId: string, reason: BreachReason): string {
  return JSON.stringify({ error: 'budget_exceeded', task: taskId, reason });
}

// Never a synthetic assistant message: a truncated stream is honest, a
// fabricated one silently corrupts the client's context.
export function terminalFrame(shape: StreamShape, taskId: string, reason: BreachReason): string {
  const body = breachBody(taskId, reason);
  if (shape === 'anthropic') return `event: error\ndata: ${body}\n\n`;
  return `data: ${body}\n\ndata: [DONE]\n\n`;
}
