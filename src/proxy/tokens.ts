import { getEncoding, type Tiktoken } from 'js-tiktoken';

// Fallback counting only. Authoritative numbers always come from upstream
// usage; every number produced here stays flagged estimated until replaced.
let encoding: Tiktoken | null = null;

function enc(): Tiktoken {
  encoding ??= getEncoding('cl100k_base');
  return encoding;
}

export function countText(text: string): number {
  if (text === '') return 0;
  return enc().encode(text).length;
}

export function countValue(value: unknown): number {
  if (value === undefined) return 0;
  return countText(typeof value === 'string' ? value : JSON.stringify(value));
}
