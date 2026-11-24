import { describe, expect, it } from 'vitest';
import { SseParser, classify } from '../src/proxy/sse.js';

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

  it('emits nothing for a chunk that ends mid-frame', () => {
    const parser = new SseParser();
    expect(parser.push('event: message_start\ndata: {"type":"mess')).toHaveLength(0);
  });
});

describe('classify', () => {
  it('labels kinds', () => {
    expect(classify({ id: null, event: null, data: '[DONE]' }).kind).toBe('done');
    expect(classify({ id: null, event: null, data: '  ' }).kind).toBe('empty');
    expect(classify({ id: null, event: null, data: '{"a":1}' }).kind).toBe('json');
    expect(classify({ id: null, event: null, data: 'oops' }).kind).toBe('malformed');
  });

  it('keeps the event name on a classified frame', () => {
    expect(classify({ id: null, event: 'message_delta', data: '{}' }).event).toBe('message_delta');
  });
});
