import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/proxy/sse.js';
import { breachBody, evaluate, isSet, terminalFrame, type VerdictInput } from '../src/proxy/verdict.js';

function input(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    caps: {},
    taskTokens: 0,
    taskUsd: 0,
    steps: 1,
    taskStartedAt: Date.now(),
    now: Date.now(),
    dead: null,
    ...over,
  };
}

describe('isSet', () => {
  it('treats 0 and null as unset', () => {
    expect(isSet(0)).toBe(false);
    expect(isSet(null)).toBe(false);
    expect(isSet(undefined)).toBe(false);
  });

  it('treats a positive number as set', () => {
    expect(isSet(1)).toBe(true);
  });
});

describe('evaluate', () => {
  it('returns null with no caps', () => {
    expect(evaluate(input())).toBeNull();
  });

  it('breaches at the exact token boundary', () => {
    expect(evaluate(input({ caps: { maxTokens: 100 }, taskTokens: 100 }))).toBe('max_tokens');
    expect(evaluate(input({ caps: { maxTokens: 100 }, taskTokens: 99 }))).toBeNull();
  });

  it('breaches steps only past the limit', () => {
    expect(evaluate(input({ caps: { maxSteps: 3 }, steps: 3 }))).toBeNull();
    expect(evaluate(input({ caps: { maxSteps: 3 }, steps: 4 }))).toBe('max_steps');
  });

  it('breaches usd at the boundary', () => {
    expect(evaluate(input({ caps: { maxUsd: 0.5 }, taskUsd: 0.5 }))).toBe('max_usd');
  });

  it('measures seconds from task start', () => {
    const now = Date.now();
    expect(evaluate(input({ caps: { maxSeconds: 10 }, taskStartedAt: now - 10_000, now }))).toBe(
      'max_seconds',
    );
    expect(evaluate(input({ caps: { maxSeconds: 10 }, taskStartedAt: now - 9_000, now }))).toBeNull();
  });

  it('reports dead ahead of every cap', () => {
    expect(evaluate(input({ caps: { maxTokens: 1 }, taskTokens: 999, dead: 'killed' }))).toBe('killed');
  });

  it('orders token before usd before steps before seconds', () => {
    const now = Date.now();
    const all = input({
      caps: { maxTokens: 1, maxUsd: 1, maxSteps: 1, maxSeconds: 1 },
      taskTokens: 5,
      taskUsd: 5,
      steps: 5,
      taskStartedAt: now - 5000,
      now,
    });
    expect(evaluate(all)).toBe('max_tokens');
    expect(evaluate({ ...all, caps: { ...all.caps, maxTokens: 0 } })).toBe('max_usd');
    expect(evaluate({ ...all, caps: { ...all.caps, maxTokens: 0, maxUsd: 0 } })).toBe('max_steps');
  });
});

describe('breach body and terminal frames', () => {
  it('builds the exact 429 body', () => {
    expect(JSON.parse(breachBody('t1', 'max_tokens'))).toEqual({
      error: 'budget_exceeded',
      task: 't1',
      reason: 'max_tokens',
    });
  });

  it('closes an OpenAI stream with the body then [DONE]', () => {
    const frame = terminalFrame('openai', 't1', 'max_tokens');
    expect(frame).toContain(breachBody('t1', 'max_tokens'));
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

  it('produces frames that parse as real SSE', () => {
    const parser = new SseParser();
    const events = parser.push(terminalFrame('openai', 't1', 'max_tokens'));
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toBe('[DONE]');
  });
});
