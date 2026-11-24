import { costOf, type Price } from './pricing.js';

// One segment per request. Request-local by construction: `prev` is a running
// request total, never a task total, and a fresh object is the only way a
// segment restarts (so `base` cannot be forgotten in a refactor).
//
// INVARIANT, enforced by the shape of #sync in accounting.ts: `prev` counts
// within one request. The task-scoped number is only ever reached through
// counter.add(). Anything that compares `prev` to a task total is a bug.
export interface Segment {
  requestId: string;
  // Running request total already reported to the task counter.
  prev: number;
  // Tokens already burned before this segment started (0 for the first).
  base: number;
  model: string | null;
  price: Price | null;
  ceiling: boolean;
  // Cost already reported for this segment, for deltaing against.
  cost: number;
}

export function startSegment(input: {
  requestId: string;
  model: string | null;
  price: Price | null;
  ceiling: boolean;
}): Segment {
  return {
    requestId: input.requestId,
    prev: 0,
    base: 0,
    model: input.model,
    price: input.price,
    ceiling: input.ceiling,
    cost: 0,
  };
}

// A new segment mid-request: everything burned so far is treated as already
// paid for, so the switch itself adds no cost and only later tokens price at
// the new rate.
export function restartSegment(
  segment: Segment,
  input: { model: string | null; price: Price | null; ceiling: boolean; requestTotal: number },
): Segment {
  return {
    requestId: segment.requestId,
    prev: 0,
    base: 0,
    model: input.model,
    price: input.price,
    ceiling: input.ceiling,
    cost: costOf(input.requestTotal, 0, input.price),
  };
}

export interface SegmentDelta {
  tokens: number;
  usd: number;
  regressed: boolean;
}

// Pure. Takes the request total and returns what to add to the task counter.
// A decrease means the provider restarted its count (new segment, retry,
// multi-message stream). Clamping to zero would discard the segment and
// undercount, which fires the cap late, so a decrease adds the new value
// wholesale. It can overcount on a spurious dip: the safe side.
export function advance(
  segment: Segment,
  requestTotal: number,
  promptTokens: number,
  completionTokens: number,
): { delta: SegmentDelta; next: Segment } {
  const local = requestTotal - segment.base;
  const regressed = local < segment.prev;
  const from = regressed ? 0 : segment.prev;
  const to = regressed ? requestTotal : local;

  const cost = costOf(promptTokens, completionTokens, segment.price);
  const costFrom = regressed ? 0 : segment.cost;

  const next: Segment = {
    ...segment,
    prev: to,
    cost: cost,
    ...(regressed ? { base: 0 } : {}),
  };

  return {
    delta: { tokens: Math.max(0, to - from), usd: Math.max(0, cost - costFrom), regressed },
    next,
  };
}
