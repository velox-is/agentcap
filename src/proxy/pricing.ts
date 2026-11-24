export interface Price {
  in: number;
  out: number;
}

// Absolute fallback when the pricing table is empty. Without this an empty table
// yields a null ceiling, cost stays 0, and the USD cap never fires — an
// unpriced-everything install would be uncapped. Roughly a frontier model's
// rate, so an unknown model is over-priced rather than free.
export const FALLBACK_CEILING: Price = { in: 15, out: 75 };

// The highest price in the table, used for any model it does not list. Pricing
// an unknown model at zero would leave its budget unbounded, so the ceiling is
// the safe default and the event log flags every use. Never returns null: an
// empty table falls back to FALLBACK_CEILING.
export function ceilingPrice(pricing: Record<string, Price>): Price {
  let inMax = 0;
  let outMax = 0;
  for (const price of Object.values(pricing)) {
    if (price.in > inMax) inMax = price.in;
    if (price.out > outMax) outMax = price.out;
  }
  if (inMax === 0 && outMax === 0) return FALLBACK_CEILING;
  return { in: inMax, out: outMax };
}

export interface ResolvedPrice {
  price: Price;
  ceiling: boolean;
}

// Never price an unknown model at zero: zero is an unbounded budget. A missing
// entry falls to the ceiling and is flagged so the log can say so.
export function resolvePrice(
  model: string | null,
  pricing: Record<string, Price>,
  ceiling: Price,
): ResolvedPrice {
  if (model !== null) {
    const exact = pricing[model];
    if (exact !== undefined) return { price: exact, ceiling: false };
  }
  return { price: ceiling, ceiling: true };
}

export function costOf(promptTokens: number, completionTokens: number, price: Price): number {
  return (promptTokens / 1e6) * price.in + (completionTokens / 1e6) * price.out;
}
