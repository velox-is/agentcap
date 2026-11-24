import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Accountant,
  SseParser,
  breachBody,
  classify,
  terminalFrame,
  type AccountantOptions,
  type Caps,
} from '../src/proxy/sse.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

// Re-chunk a whole stream at size N so framing is exercised at every offset.
function rechunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function accountant(caps: Caps, extra: Partial<AccountantOptions> = {}) {
  return new Accountant({
    shape: 'openai',
    taskId: 'task-1',
    caps,
    steps: 1,
    startedAt: Date.now(),
    price: { in: 1, out: 2 },
    ...extra,
  });
}

function drain(acc: Accountant, parts: string[]) {
  const frames: string[] = [];
  let breach = null;
  for (const part of parts) {
    const obs = acc.observe(part);
    frames.push(...obs.frames);
    breach ??= obs.breach;
  }
  const tail = acc.flush();
  frames.push(...tail.frames);
  breach ??= tail.breach;
  return { frames, breach, totals: acc.totals, sawDone: acc.sawDone };
}

describe('SseParser framing', () => {
  it('splits events on any terminator', () => {
    const parser = new SseParser();
    expect(parser.push('data: a\n\n')).toHaveLength(1);
    expect(parser.push('data: b\r\n\r\n')).toHaveLength(1);
    expect(parser.push('data: c\r\r')).toHaveLength(1);
  });

  it('survives a chunk split inside a frame', () => {
    const parser = new SseParser();
    expect(parser.push('data: hel')).toHaveLength(0);
    expect(parser.push('lo\n\n')[0]?.data).toBe('hello');
  });

  it('joins multi-line data with newlines', () => {
    const parser = new SseParser();
    expect(parser.push('data: a\ndata: b\n\n')[0]?.data).toBe('a\nb');
  });

  it('captures event and id fields', () => {
    const parser = new SseParser();
    const [event] = parser.push('id: 7\nevent: ping\ndata: x\n\n');
    expect(event).toEqual({ id: '7', event: 'ping', data: 'x' });
  });

  it('ignores comment lines', () => {
    const parser = new SseParser();
    expect(parser.push(': keepalive\n\n')).toHaveLength(0);
  });

  it('flushes a trailing frame with no blank line', () => {
    const parser = new SseParser();
    parser.push('data: tail');
    expect(parser.flush()[0]?.data).toBe('tail');
  });

  it('treats a bare field line as empty data', () => {
    const parser = new SseParser();
    expect(parser.push('data\n\n')[0]?.data).toBe('');
  });
});

describe('classify', () => {
  it('labels kinds', () => {
    expect(classify({ id: null, event: null, data: '[DONE]' }).kind).toBe('done');
    expect(classify({ id: null, event: null, data: '  ' }).kind).toBe('empty');
    expect(classify({ id: null, event: null, data: '{"a":1}' }).kind).toBe('json');
    expect(classify({ id: null, event: null, data: 'oops' }).kind).toBe('malformed');
  });
});

describe('accounting', () => {
  it('takes exact usage from an OpenAI stream', () => {
    const acc = accountant({});
    const result = drain(acc, rechunk(fixture('openai-usage.sse'), 7));
    expect(result.totals).toEqual({ promptTokens: 41, completionTokens: 9, estimated: false });
    expect(result.sawDone).toBe(true);
  });

  it('takes exact usage from an Anthropic stream', () => {
    const acc = accountant({}, { shape: 'anthropic' });
    const result = drain(acc, rechunk(fixture('anthropic-usage.sse'), 5));
    // input_tokens + cache_read_input_tokens
    expect(result.totals).toEqual({ promptTokens: 42, completionTokens: 9, estimated: false });
  });

  it('estimates when upstream omits usage, and keeps the flag', () => {
    const acc = accountant({});
    acc.seedPrompt({ messages: [{ role: 'user', content: 'hi' }] });
    const result = drain(acc, rechunk(fixture('openai-no-usage.sse'), 11));
    expect(result.totals.estimated).toBe(true);
    expect(result.totals.completionTokens).toBeGreaterThan(0);
    expect(result.totals.promptTokens).toBeGreaterThan(0);
  });

  it('replaces the estimate the moment real usage lands', () => {
    const acc = accountant({});
    acc.seedPrompt({ messages: [{ role: 'user', content: 'a much longer prompt than the answer' }] });
    expect(acc.totals.estimated).toBe(true);
    drain(acc, rechunk(fixture('openai-usage.sse'), 9));
    expect(acc.totals).toEqual({ promptTokens: 41, completionTokens: 9, estimated: false });
  });

  it('keeps upstream prompt tokens when a stream has usage', () => {
    const acc = accountant({});
    acc.seedPrompt({ messages: [{ role: 'user', content: 'x'.repeat(400) }] });
    drain(acc, rechunk(fixture('openai-usage.sse'), 13));
    expect(acc.totals.promptTokens).toBe(41);
  });

  it('counts malformed frames without stopping', () => {
    const acc = accountant({});
    const result = drain(acc, rechunk(fixture('openai-malformed.sse'), 6));
    expect(acc.malformed).toBe(2);
    expect(result.totals.completionTokens).toBeGreaterThan(0);
  });

  it('recognises a split [DONE]', () => {
    const acc = accountant({});
    const result = drain(acc, rechunk(fixture('openai-done-split.sse'), 3));
    expect(result.sawDone).toBe(true);
  });

  it('counts a truncated stream with no [DONE]', () => {
    const acc = accountant({});
    const result = drain(acc, rechunk(fixture('openai-truncated.sse'), 8));
    expect(result.sawDone).toBe(false);
    expect(result.totals.completionTokens).toBeGreaterThan(0);
  });

  it('returns every frame verbatim, in order', () => {
    const acc = accountant({});
    const original = fixture('openai-usage.sse');
    const result = drain(acc, rechunk(original, 4));
    expect(result.frames.join('')).toBe(original);
  });
});

describe('caps', () => {
  // Breach must fire on the frame that crosses the line, after that frame is
  // already in the frame list, so the client always receives chunk N.
  it('breaches max_tokens on the crossing chunk, not the one after', () => {
    const acc = accountant({ maxTokens: 45 });
    const parts = rechunk(fixture('openai-usage.sse'), 9);
    const frames: string[] = [];
    let breachAt = -1;
    let obsCount = 0;
    for (const part of parts) {
      const obs = acc.observe(part);
      obsCount += obs.frames.length;
      frames.push(...obs.frames);
      if (obs.breach !== null) {
        breachAt = obsCount;
        expect(obs.breach).toBe('max_tokens');
        break;
      }
    }
    expect(breachAt).toBeGreaterThan(0);
    expect(frames.length).toBe(breachAt);
    expect(frames.join('')).toContain('chat.completion.chunk');
  });

  it('breaches on cumulative tokens, not per-chunk', () => {
    // The fixture is four 1-token chunks. A 3-token cap must fire on chunk 3,
    // which proves the running total accumulates rather than resetting.
    const acc = accountant({ maxTokens: 3 });
    const result = drain(acc, rechunk(fixture('openai-truncated.sse'), 8));
    expect(result.breach).toBe('max_tokens');
    expect(result.frames.length).toBeGreaterThanOrEqual(3);
  });

  it('does not breach a cap the stream never reaches', () => {
    const acc = accountant({ maxTokens: 10_000 });
    expect(drain(acc, rechunk(fixture('openai-truncated.sse'), 8)).breach).toBeNull();
  });

  it('breaches max_steps', () => {
    const acc = accountant({ maxSteps: 2 }, { steps: 3 });
    expect(drain(acc, rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('max_steps');
  });

  it('breaches max_usd once cost crosses', () => {
    // 41 in @ $1/M + 9 out @ $2/M is well under a cent; price at $1000/M.
    const acc = accountant({ maxUsd: 0.001 }, { price: { in: 1000, out: 2000 } });
    expect(drain(acc, rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('max_usd');
  });

  it('breaches max_seconds', () => {
    const acc = accountant({ maxSeconds: 1 }, { startedAt: Date.now() - 2000 });
    expect(drain(acc, rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('max_seconds');
  });

  it('reports killed ahead of any cap', () => {
    const acc = accountant({ maxTokens: 1 }, { isDead: () => 'killed' });
    expect(drain(acc, rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('killed');
  });

  it('stops reporting a breach once closed', () => {
    const acc = accountant({ maxTokens: 1 });
    expect(drain(acc, rechunk(fixture('openai-usage.sse'), 20)).breach).toBe('max_tokens');
    acc.close();
    expect(acc.observe('data: {}\n\n').breach).toBeNull();
  });

  it('treats a cap of 0 as unlimited', () => {
    const acc = accountant({ maxTokens: 0 });
    expect(drain(acc, rechunk(fixture('openai-usage.sse'), 20)).breach).toBeNull();
  });

  it('breaches an empty cap set never', () => {
    const acc = accountant({});
    expect(drain(acc, rechunk(fixture('openai-usage.sse'), 20)).breach).toBeNull();
  });
});

describe('terminal frames', () => {
  it('sends the exact 429 body and closes OpenAI with [DONE]', () => {
    const body = breachBody('t1', 'max_tokens');
    expect(JSON.parse(body)).toEqual({ error: 'budget_exceeded', task: 't1', reason: 'max_tokens' });
    const frame = terminalFrame('openai', 't1', 'max_tokens');
    expect(frame).toContain(body);
    expect(frame.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('uses an error event for Anthropic', () => {
    const frame = terminalFrame('anthropic', 't1', 'killed');
    expect(frame.startsWith('event: error\n')).toBe(true);
    expect(JSON.parse(frame.split('\n')[1]!.slice('data: '.length))).toMatchObject({
      error: 'budget_exceeded',
      reason: 'killed',
    });
  });

  it('terminal frames parse as real SSE', () => {
    const parser = new SseParser();
    const events = parser.push(terminalFrame('openai', 't1', 'max_tokens'));
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toBe('[DONE]');
  });
});
