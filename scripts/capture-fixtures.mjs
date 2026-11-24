// Captures real SSE bytes from a mock upstream into tests/fixtures/.
// Fixtures are recorded off the wire, not hand-written, so the parser is
// tested against the chunk boundaries and framing that actually occur.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'tests/fixtures';
mkdirSync(OUT, { recursive: true });

const CHUNK = 30; // deliberately small: forces splits inside frames
const TEXT = 'Streaming prose that arrives in pieces.';

function split(payload, size = CHUNK) {
  const parts = [];
  for (let i = 0; i < payload.length; i += size) parts.push(payload.slice(i, i + size));
  return parts;
}

function sse(parts, delay = 2) {
  return async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const part of parts) {
      res.write(part);
      await new Promise((r) => setTimeout(r, delay));
    }
    res.end();
  };
}

function openAiChunk(text, finish = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: text === null ? {} : { content: text }, finish_reason: finish }],
  })}\n\n`;
}

const usageFrame = `data: ${JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50 },
})}\n\n`;

const openAi = TEXT.split(' ')
  .map((w, i) => openAiChunk(i === 0 ? w : ` ${w}`))
  .concat([usageFrame, 'data: [DONE]\n\n']);

const anthropic = [
  `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      usage: { input_tokens: 37, cache_read_input_tokens: 5, output_tokens: 1 },
    },
  })}\n\n`,
]
  .concat(
    TEXT.split(' ').map((w, i) =>
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: i === 0 ? w : ` ${w}` },
      })}\n\n`,
    ),
  )
  .concat([
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 9 },
    })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);

const fixtures = {
  'openai-usage.sse': split(openAi.join('')),
  'openai-no-usage.sse': split(openAi.filter((f) => !f.includes('"usage"')).join('')),
  'anthropic-usage.sse': split(anthropic.join('')),
  'openai-malformed.sse': split(
    [
      openAiChunk('ok'),
      'data: {"choices":[{"delta":{"content":\n\n',
      'data: not json at all\n\n',
      openAiChunk(' after'),
      'data: [DONE]\n\n',
    ].join(''),
  ),
  'openai-done-split.sse': split(`${openAiChunk('a')}data: [DONE]\n\n`),
  'openai-truncated.sse': split(openAi.slice(0, 4).join('')),
};

// A provider that reports only per-frame output_tokens, never a running total.
const perChunk = [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 12 } } })}\n\n`,
]
  .concat(
    [1, 2, 3, 4].map(
      (n) =>
        `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: n } })}\n\n`,
    ),
  )
  .concat(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);

fixtures['anthropic-per-chunk-usage.sse'] = split(perChunk.join(''));

const routes = new Map();
for (const [name, parts] of Object.entries(fixtures)) routes.set(`/${name}`, sse(parts));
routes.set('/slow', sse(split(openAi.join('')), 120));

const server = createServer((req, res) => {
  const handler = routes.get(req.url ?? '');
  if (handler === undefined) return void res.writeHead(404).end();
  void handler(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

for (const name of Object.keys(fixtures)) {
  const text = await (await fetch(`http://127.0.0.1:${port}/${name}`)).text();
  writeFileSync(join(OUT, name), text, 'utf8');
  console.log(`${name} ${text.length}B ${text.split('\n\n').length - 1} frames`);
}

server.close();
