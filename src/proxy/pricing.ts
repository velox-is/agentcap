export interface Price {
  in: number;
  out: number;
}

// The highest price in the table, used for any model it does not list. Pricing
// an unknown model at zero would leave its budget unbounded, so the ceiling is
// the safe default and the event log flags every use.
export function ceilingPrice(pricing: Record<string, Price>): Price | null {
  let inMax = 0;
  let outMax = 0;
  let seen = false;
  for (const price of Object.values(pricing)) {
    seen = true;
    if (price.in > inMax) inMax = price.in;
    if (price.out > outMax) outMax = price.out;
  }
  return seen ? { in: inMax, out: outMax } : null;
}

export interface ResolvedPrice {
  price: Price | null;
  ceiling: boolean;
}

// Never price an unknown model at zero: zero is an unbounded budget. A missing
// entry falls to the ceiling and is flagged so the log can say so.
export function resolvePrice(
  model: string | null,
  pricing: Record<string, Price>,
  ceiling: Price | null,
): ResolvedPrice {
  if (model !== null) {
    const exact = pricing[model];
    if (exact !== undefined) return { price: exact, ceiling: false };
  }
  if (ceiling !== null) return { price: ceiling, ceiling: true };
  return { price: null, ceiling: true };
}

export function costOf(promptTokens: number, completionTokens: number, price: Price | null): number {
  if (price === null) return 0;
  return (promptTokens / 1e6) * price.in + (completionTokens / 1e6) * price.out;
}
