// Framing only: split the wire into SSE events and classify each one.
// Accounting lives in accounting.ts, verdicts in verdict.ts.
//
// The passthrough forwards the verbatim bytes of every frame, so the client
// sees exactly what upstream sent, at the moment it arrives.

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

export function serialize(event: SseEvent): string {
  let out = '';
  if (event.id !== null) out += `id: ${event.id}\n`;
  if (event.event !== null) out += `event: ${event.event}\n`;
  for (const line of event.data.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}
