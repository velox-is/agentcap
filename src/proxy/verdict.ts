export type BreachReason = 'max_tokens' | 'max_steps' | 'max_usd' | 'max_seconds' | 'killed';

export interface Caps {
  maxTokens?: number | null;
  maxSteps?: number | null;
  maxUsd?: number | null;
  maxSeconds?: number | null;
}

// 0 and null both mean unlimited. `0 != null` is true in JS, so a naive null
// check would breach every request on frame one; the test is `> 0`.
export function isSet(cap: number | null | undefined): cap is number {
  return cap != null && cap > 0;
}

export interface VerdictInput {
  caps: Caps;
  taskTokens: number;
  taskUsd: number;
  steps: number;
  taskStartedAt: number;
  now: number;
  dead: BreachReason | null;
}

export function evaluate(input: VerdictInput): BreachReason | null {
  if (input.dead !== null) return input.dead;
  return exceeds(
    input.caps,
    input.taskTokens,
    input.taskUsd,
    input.steps,
    input.taskStartedAt,
    input.now,
  );
}

// Every cap currently breached, not just the first in priority order. Late
// usage needs the set: a task already over max_tokens whose late tokens finally
// break max_usd must attribute max_usd, and a single first-match answer keeps
// saying max_tokens. Order is priority order, so `exceeds` can take [0].
export function breachedCaps(
  caps: Caps,
  taskTokens: number,
  taskUsd: number,
  steps: number,
  taskStartedAt: number,
  now: number,
): BreachReason[] {
  const out: BreachReason[] = [];
  if (isSet(caps.maxTokens) && taskTokens >= caps.maxTokens) out.push('max_tokens');
  if (isSet(caps.maxUsd) && taskUsd >= caps.maxUsd) out.push('max_usd');
  if (isSet(caps.maxSteps) && steps > caps.maxSteps) out.push('max_steps');
  if (isSet(caps.maxSeconds) && now - taskStartedAt >= caps.maxSeconds * 1000) {
    out.push('max_seconds');
  }
  return out;
}

// The cap comparison alone, ignoring whether the task is already dead.
// `evaluate` short-circuits to the death reason for a dead task, so it cannot
// say whether tokens that just arrived would have broken a cap by themselves.
export function exceeds(
  caps: Caps,
  taskTokens: number,
  taskUsd: number,
  steps: number,
  taskStartedAt: number,
  now: number,
): BreachReason | null {
  return breachedCaps(caps, taskTokens, taskUsd, steps, taskStartedAt, now)[0] ?? null;
}

export function breachBody(taskId: string, reason: BreachReason): string {
  return JSON.stringify({ error: 'budget_exceeded', task: taskId, reason });
}

// Never a synthetic assistant message: a truncated stream is honest, a
// fabricated one silently corrupts the client's context.
export function terminalFrame(shape: 'openai' | 'anthropic', taskId: string, reason: BreachReason): string {
  const body = breachBody(taskId, reason);
  if (shape === 'anthropic') return `event: error\ndata: ${body}\n\n`;
  return `data: ${body}\n\ndata: [DONE]\n\n`;
}
