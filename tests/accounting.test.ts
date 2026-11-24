import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Accountant,
  counterFor,
  release,
  resetRegistry,
  type Price,
  type RegressInfo,
  type TaskCounter,
  type TaskSpend,
} from '../src/proxy/accounting.js';
import type { BreachReason, Caps } from '../src/proxy/verdict.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function rechunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const PRICING: Record<string, Price> = { m1: { in: 1, out: 2 }, m2: { in: 10, out: 20 } };

function spend(caps: Caps, extra: Partial<TaskSpend> = {}): TaskSpend {
  return {
    tokens: 0,
    usd: 0,
    startedAt: Date.now(),
    steps: 1,
    caps,
    dead: () => null as BreachReason | null,
    ...extra,
  };
}

let seq = 0;
function counter(caps: Caps, extra: Partial<TaskSpend> = {}): TaskCounter {
  seq += 1;
  return counterFor(`t-${seq}`, () => spend(caps, extra));
}

interface AccOpts {
  shape?: 'openai' | 'anthropic';
  model?: string | null;
  pricing?: Record<string, Price>;
  ceilingPrice?: Price | null;
  onRegress?: (info: RegressInfo) => void;
  onUnpriced?: (model: string | null) => void;
}

function accountantFor(c: TaskCounter | null, opts: AccOpts = {}) {
  return new Accountant({
    shape: opts.shape ?? 'openai',
    counter: c,
    model: opts.model === undefined ? 'm1' : opts.model,
    pricing: opts.pricing ?? PRICING,
    ceilingPrice: opts.ceilingPrice ?? null,
    onRegress: opts.onRegress,
    onUnpriced: opts.onUnpriced,
  });
}

function drain(acc: Accountant, parts: string[]) {
  const frames: string[] = [];
  let breach: BreachReason | null = null;
  for (const part of parts) {
    const obs = acc.observe(part);
    frames.push(...obs.frames);
    breach ??= obs.breach;
  }
  const tail = acc.flush();
  frames.push(...tail.frames);
  breach ??= tail.breach;
  return { frames, breach, totals: acc.totals };
}

beforeEach(() => resetRegistry());

describe('request accounting', () => {
  it('takes exact usage from an OpenAI stream', () => {
    const acc = accountantFor(null);
    const result = drain(acc, rechunk(fixture('openai-usage.sse'), 7));
    expect(result.totals).toEqual({ promptTokens: 41, completionTokens: 9, estimated: false });
  });

  it('takes exact usage from an Anthropic stream', () => {
    const acc = accountantFor(null, { shape: 'anthropic' });
    const result = drain(acc, rechunk(fixture('anthropic-usage.sse'), 5));
    // input_tokens + cache_read_input_tokens
    expect(result.totals).toEqual({ promptTokens: 42, completionTokens: 9, estimated: false });
  });

  it('estimates when upstream omits usage and keeps the flag', () => {
    const acc = accountantFor(null);
    acc.seedPrompt({ messages: [{ role: 'user', content: 'hi' }] });
    const result = drain(acc, rechunk(fixture('openai-no-usage.sse'), 11));
    expect(result.totals.estimated).toBe(true);
    expect(result.totals.completionTokens).toBeGreaterThan(0);
    expect(result.totals.promptTokens).toBeGreaterThan(0);
  });

  it('replaces the estimate the moment real usage lands', () => {
    const acc = accountantFor(null);
    acc.seedPrompt({ messages: [{ role: 'user', content: 'a much longer prompt than the answer' }] });
    expect(acc.totals.estimated).toBe(true);
    drain(acc, rechunk(fixture('openai-usage.sse'), 9));
    expect(acc.totals).toEqual({ promptTokens: 41, completionTokens: 9, estimated: false });
  });

  it('keeps upstream prompt tokens over the estimate', () => {
    const acc = accountantFor(null);
    acc.seedPrompt({ messages: [{ role: 'user', content: 'x'.repeat(400) }] });
    drain(acc, rechunk(fixture('openai-usage.sse'), 13));
    expect(acc.totals.promptTokens).toBe(41);
  });

  it('counts malformed frames without stopping', () => {
    const acc = accountantFor(null);
    const result = drain(acc, rechunk(fixture('openai-malformed.sse'), 6));
    expect(acc.malformed).toBe(2);
    expect(result.totals.completionTokens).toBeGreaterThan(0);
  });

  it('recognises a split [DONE]', () => {
    const acc = accountantFor(null);
    expect(drain(acc, rechunk(fixture('openai-done-split.sse'), 3)).frames.length).toBeGreaterThan(0);
    expect(acc.sawDone).toBe(true);
  });

  it('returns every frame verbatim, in order', () => {
    const acc = accountantFor(null);
    const original = fixture('openai-usage.sse');
    const result = drain(acc, rechunk(original, 4));
    expect(result.frames.join('')).toBe(original);
  });
});

describe('task counter', () => {
  it('accumulates across requests on one task', () => {
    const c = counter({});
    drain(accountantFor(c), rechunk(fixture('openai-usage.sse'), 9));
    expect(c.tokens).toBe(50);
    drain(accountantFor(c), rechunk(fixture('openai-usage.sse'), 9));
    expect(c.tokens).toBe(100);
  });

  it('seeds from prior spend exactly once', () => {
    const seed = () => spend({}, { tokens: 500, usd: 1 });
    const c = counterFor('stable-id', seed);
    expect(c.tokens).toBe(500);
    // A second lookup must not re-seed from a different (larger) source.
    const again = counterFor('stable-id', () => spend({}, { tokens: 999 }));
    expect(again).toBe(c);
    expect(again.tokens).toBe(500);
  });

  it('does not reset the task total on a cumulative usage frame', () => {
    // Two messages in a row: the second message_start reports its own input
    // tokens, which must not walk the task total back to that number.
    const c = counter({});
    drain(accountantFor(c, { shape: 'anthropic' }), rechunk(fixture('anthropic-usage.sse'), 5));
    const afterFirst = c.tokens;
    expect(afterFirst).toBeGreaterThan(0);
    drain(accountantFor(c, { shape: 'anthropic' }), rechunk(fixture('anthropic-usage.sse'), 5));
    expect(c.tokens).toBeGreaterThanOrEqual(afterFirst * 2 - 1);
  });

  it('moves the task total by the delta of a replacing usage frame', () => {
    // Per-chunk-delta provider. The request total is replaced on every frame,
    // so the task total only ever takes the positive step between frames:
    // 1, 2, 3, 4 lands as +1 four times, never 1+2+3+4.
    const c = counter({});
    const acc = accountantFor(c, { shape: 'anthropic' });
    drain(acc, rechunk(fixture('anthropic-per-chunk-usage.sse'), 6));
    expect(acc.totals.completionTokens).toBe(4);
    // 12 prompt + 4 completion, counted once each.
    expect(c.tokens).toBe(16);
  });

  it('keeps the task total when a later request reports a smaller total', () => {
    const c = counter({});
    drain(accountantFor(c, { shape: 'anthropic' }), rechunk(fixture('anthropic-usage.sse'), 5));
    const after = c.tokens;
    // A short second message: its own totals are lower, the task must not drop.
    drain(accountantFor(c, { shape: 'anthropic' }), rechunk(fixture('anthropic-per-chunk-usage.sse'), 5));
    expect(c.tokens).toBeGreaterThan(after);
  });

  it('adds a regressed segment wholesale and never walks the task total back', () => {
    const c = counter({});
    const regressions: RegressInfo[] = [];
    const acc = accountantFor(c, { onRegress: (info) => regressions.push(info) });

    // 10 prompt + completion climbing to 10, then the provider restarts at 3.
    acc.observe(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`);
    const before = c.tokens;
    expect(before).toBe(20);
    acc.observe(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`);

    // Clamping to zero would have discarded the restart and undercounted.
    expect(c.tokens).toBe(before + 13);
    expect(regressions.length).toBeGreaterThanOrEqual(1);
    expect(regressions[0]!.next).toBe(13);
  });

  it('keeps the task total monotone non-decreasing through a whole regressed stream', () => {
    const c = counter({});
    const seen: number[] = [];
    const acc = accountantFor(c, { onRegress: () => undefined });
    for (const part of rechunk(fixture('openai-usage-regress.sse'), 6)) {
      acc.observe(part);
      seen.push(c.tokens);
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });

  it('merges a partial usage frame field-wise', () => {
    const c = counter({});
    const acc = accountantFor(c);
    // First frame sets both, second carries completion only.
    acc.observe(`data: ${JSON.stringify({ usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\n`);
    acc.observe(`data: ${JSON.stringify({ usage: { completion_tokens: 15 } })}\n\n`);
    expect(acc.totals.promptTokens).toBe(30);
    expect(acc.totals.completionTokens).toBe(15);
  });

  it('applies usage that arrives in a trailer after [DONE]', () => {
    const c = counter({});
    const acc = accountantFor(c);
    drain(acc, rechunk(fixture('openai-usage-trailer.sse'), 7));
    // 44 prompt + 6 completion, despite the terminal frame coming first.
    expect(c.tokens).toBe(50);
  });

  it('prices a mid-stream model switch from a recorded stream', () => {
    const c = counter({});
    const pricing = { 'gpt-4o-mini': { in: 0.15, out: 0.6 }, 'gpt-4o': { in: 2.5, out: 10 } };
    const acc = accountantFor(c, { model: 'gpt-4o-mini', pricing });
    drain(acc, rechunk(fixture('openai-model-switch.sse'), 8));
    // 100 tokens at mini + 100 extra at 4o, priced per segment.
    expect(acc.cost).toBeCloseTo(100 / 1e6 * 0.15 + 100 / 1e6 * 2.5, 9);
  });

  it('prices an unpriced model at the ceiling from a recorded stream', () => {
    const flagged: (string | null)[] = [];
    const acc = accountantFor(counter({}), {
      model: 'gpt-4o-mini',
      pricing: { 'gpt-4o-mini': { in: 0.15, out: 0.6 } },
      ceilingPrice: { in: 5, out: 15 },
      onUnpriced: (m) => flagged.push(m),
    });
    drain(acc, rechunk(fixture('openai-model-switch.sse'), 8));
    // gpt-4o is unknown: its 100 tokens are priced at the ceiling, not zero.
    expect(acc.cost).toBeGreaterThan(100 / 1e6 * 0.15);
    expect(flagged).toContain('gpt-4o');
  });

  it('keeps the entry while siblings stream and evicts only after the last leaves', () => {
    const c = counterFor('evict-id', () => spend({}));
    c.enter();
    c.enter();
    release('evict-id');
    // Two still active: the entry must survive, and must not re-seed.
    expect(counterFor('evict-id', () => spend({}, { tokens: 999 }))).toBe(c);

    c.leave();
    expect(c.activeRequests).toBe(1);
    c.leave();
    expect(c.activeRequests).toBe(0);

    // Nothing active: the entry goes and the next request re-seeds.
    release('evict-id');
    expect(counterFor('evict-id', () => spend({}, { tokens: 7 })).tokens).toBe(7);
  });

  it('a sibling still streaming breaches on its next frame after another breached', () => {
    const c = counterFor('sib', () => spend({ maxTokens: 60 }));
    c.enter();
    c.enter();
    const first = accountantFor(c);
    const sibling = accountantFor(c);

    drain(first, rechunk(fixture('openai-usage.sse'), 9));
    // The breaching request leaves; the sibling keeps the entry alive.
    c.breached = true;
    c.leave();
    release('sib');
    expect(c.activeRequests).toBe(1);

    // The sibling sees the shared total, not a re-seeded one, and breaches.
    expect(drain(sibling, rechunk(fixture('openai-usage.sse'), 9)).breach).toBe('max_tokens');
  });
});

describe('field-wise usage merge', () => {
  it('keeps prompt tokens when a later frame carries only completion', () => {
    const acc = accountantFor(null);
    acc.applyUsage(37, null);
    acc.observe(`data: ${JSON.stringify({ usage: { completion_tokens: 12 } })}\n\n`);
    // The partial frame must not zero the prompt count back to the estimate.
    expect(acc.totals.promptTokens).toBe(37);
    expect(acc.totals.completionTokens).toBe(12);
  });

  it('keeps completion tokens when a later frame carries only prompt', () => {
    const acc = accountantFor(null);
    acc.applyUsage(null, 8);
    acc.observe(`data: ${JSON.stringify({ usage: { prompt_tokens: 20 } })}\n\n`);
    expect(acc.totals.completionTokens).toBe(8);
  });

  it('stays estimated until both fields have been seen', () => {
    const acc = accountantFor(null);
    acc.applyUsage(10, null);
    expect(acc.totals.estimated).toBe(true);
    acc.applyUsage(null, 4);
    expect(acc.totals.estimated).toBe(false);
  });
});

describe('usage timing', () => {
  it('applies usage that arrives after the terminal frame', () => {
    const c = counter({});
    const acc = accountantFor(c);
    acc.observe('data: [DONE]\n\n');
    acc.applyUsage(25, 5);
    expect(acc.totals.promptTokens).toBe(25);
    expect(c.tokens).toBe(30);
  });

  it('applies header usage before the first chunk', () => {
    const c = counter({});
    const acc = accountantFor(c);
    acc.applyUsage(15, 3);
    acc.observe(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
    expect(acc.totals.estimated).toBe(false);
    expect(c.tokens).toBeGreaterThanOrEqual(18);
  });
});

describe('pricing segments', () => {
  it('prices a model switch on both sides of the switch', () => {
    const c = counter({});
    const acc = accountantFor(c, { model: 'm1' });

    // 100k prompt tokens at m1 ($1/M)...
    acc.applyUsage(100_000, 0);
    expect(acc.cost).toBeCloseTo(0.1, 6);

    acc.observe(
      `data: ${JSON.stringify({ model: 'm2', usage: { prompt_tokens: 100_000, completion_tokens: 0 } })}\n\n`,
    );
    // Tokens already counted must not be re-priced at the new rate.
    expect(acc.cost).toBeCloseTo(0.1, 6);

    acc.observe(
      `data: ${JSON.stringify({ model: 'm2', usage: { prompt_tokens: 200_000, completion_tokens: 0 } })}\n\n`,
    );
    // The extra 100k is priced at m2 ($10/M).
    expect(acc.cost).toBeCloseTo(1.1, 6);
    expect(acc.model).toBe('m2');
  });

  it('prices an unknown model at the ceiling and flags it', () => {
    const flagged: (string | null)[] = [];
    const acc = accountantFor(counter({}), {
      model: 'mystery',
      ceilingPrice: { in: 100, out: 200 },
      onUnpriced: (m) => flagged.push(m),
    });
    acc.applyUsage(1_000_000, 0);
    expect(acc.cost).toBeCloseTo(100, 6);
    expect(flagged).toEqual(['mystery']);
  });

  it('never prices a known model at the ceiling', () => {
    const flagged: (string | null)[] = [];
    const acc = accountantFor(counter({}), {
      model: 'm1',
      ceilingPrice: { in: 100, out: 200 },
      onUnpriced: (m) => flagged.push(m),
    });
    acc.applyUsage(1_000_000, 0);
    expect(acc.cost).toBeCloseTo(1, 6);
    expect(flagged).toEqual([]);
  });
});

describe('verdicts against shared state', () => {
  it('breaches max_tokens cumulatively across requests', () => {
    const c = counter({ maxTokens: 60 });
    const first = drain(accountantFor(c), rechunk(fixture('openai-usage.sse'), 9));
    expect(first.breach).toBeNull();
    const second = drain(accountantFor(c), rechunk(fixture('openai-usage.sse'), 9));
    expect(second.breach).toBe('max_tokens');
  });

  it('breaches on the frame that crosses, having delivered it', () => {
    const c = counter({ maxTokens: 45 });
    const acc = accountantFor(c);
    const parts = rechunk(fixture('openai-usage.sse'), 9);
    let delivered = 0;
    for (const part of parts) {
      const obs = acc.observe(part);
      delivered += obs.frames.length;
      if (obs.breach !== null) {
        expect(obs.breach).toBe('max_tokens');
        expect(delivered).toBeGreaterThan(0);
        return;
      }
    }
    throw new Error('never breached');
  });

  it('breaches max_usd from derived cost', () => {
    const c = counter({ maxUsd: 0.001 });
    const acc = accountantFor(c, { pricing: { m1: { in: 1000, out: 2000 } } });
    expect(drain(acc, rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('max_usd');
  });

  it('measures max_seconds from task creation, not request start', () => {
    const c = counter({ maxSeconds: 1 }, { startedAt: Date.now() - 5000 });
    expect(drain(accountantFor(c), rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('max_seconds');
  });

  it('reports killed ahead of any cap', () => {
    const c = counter({ maxTokens: 1 }, { dead: () => 'killed' });
    expect(drain(accountantFor(c), rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('killed');
  });

  it('treats 0 and null caps as unlimited', () => {
    for (const cap of [0, null]) {
      const c = counter({ maxTokens: cap, maxUsd: cap, maxSteps: cap, maxSeconds: cap });
      expect(drain(accountantFor(c), rechunk(fixture('openai-usage.sse'), 20)).breach).toBeNull();
    }
  });

  it('never breaches with no counter', () => {
    expect(drain(accountantFor(null), rechunk(fixture('openai-usage.sse'), 20)).breach).toBeNull();
  });
});
