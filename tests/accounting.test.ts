import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Accountant,
  counterFor,
  resetRegistry,
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

function spend(caps: Caps, extra: Partial<TaskSpend> = {}): TaskSpend {
  return {
    tokens: 0,
    usd: 0,
    startedAt: Date.now(),
    steps: 1,
    caps,
    price: { in: 1, out: 2 },
    dead: () => null as BreachReason | null,
    ...extra,
  };
}

function counter(caps: Caps, extra: Partial<TaskSpend> = {}): TaskCounter {
  return counterFor(`t-${Math.random()}`, () => spend(caps, extra));
}

function accountantFor(c: TaskCounter | null, shape: 'openai' | 'anthropic' = 'openai') {
  return new Accountant({ shape, counter: c });
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
    const acc = accountantFor(null, 'anthropic');
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
    drain(accountantFor(c, 'anthropic'), rechunk(fixture('anthropic-usage.sse'), 5));
    const afterFirst = c.tokens;
    expect(afterFirst).toBeGreaterThan(0);
    drain(accountantFor(c, 'anthropic'), rechunk(fixture('anthropic-usage.sse'), 5));
    expect(c.tokens).toBeGreaterThanOrEqual(afterFirst * 2 - 1);
  });

  it('moves the task total by the delta of a replacing usage frame', () => {
    // Per-chunk-delta provider. The request total is replaced on every frame,
    // so the task total only ever takes the positive step between frames:
    // 1, 2, 3, 4 lands as +1 four times, never 1+2+3+4.
    const c = counter({});
    const acc = accountantFor(c, 'anthropic');
    drain(acc, rechunk(fixture('anthropic-per-chunk-usage.sse'), 6));
    expect(acc.totals.completionTokens).toBe(4);
    // 12 prompt + 4 completion, counted once each.
    expect(c.tokens).toBe(16);
  });

  it('keeps the task total when a later request reports a smaller total', () => {
    const c = counter({});
    drain(accountantFor(c, 'anthropic'), rechunk(fixture('anthropic-usage.sse'), 5));
    const after = c.tokens;
    // A short second message: its own totals are lower, the task must not drop.
    drain(accountantFor(c, 'anthropic'), rechunk(fixture('anthropic-per-chunk-usage.sse'), 5));
    expect(c.tokens).toBeGreaterThan(after);
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
    const c = counter({ maxUsd: 0.001 }, { price: { in: 1000, out: 2000 } });
    expect(drain(accountantFor(c), rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('max_usd');
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
