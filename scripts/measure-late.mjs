// Measures the two numbers the case study has to report: tokens spent before the
// cap fired, and tokens that arrived after the task was already dead. Runs the
// real CLI, a mock upstream, and real OTel spans flushed after the breach.
//
// Prints a JSON blob so the numbers in the write-up come from a run.
// Fixed ports, so nothing else may be listening.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'agentcap-measure-'));
const upPort = 4198;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock upstream: 4 frames of 70 cumulative tokens, 200ms apart. With
// max-tokens 100 the cap trips on the second frame.
const up = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tok ' + i } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 40 * i, completion_tokens: 30 * i } })}\n\n`);
      if (i >= 4) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 200);
  });
});
await new Promise((r) => up.listen(upPort, '127.0.0.1', r));

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

await run(['init']);
writeFileSync(
  join(root, 'agentcap.config.json'),
  JSON.stringify({
    bind: '127.0.0.1',
    ports: { proxy: 4100, otel: 4101, dashboard: 4102 },
    providers: { demo: { baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKeyEnv: 'DEMO_KEY', models: ['demo-small'] } },
    pricing: { 'demo-small': { in: 0.15, out: 0.6 } },
  }),
);

const server = spawn(process.execPath, [CLI, 'start'], {
  cwd: root,
  env: { ...process.env, DEMO_KEY: 'k' },
});
let boot = '';
server.stdout.on('data', (d) => (boot += d));
for (let i = 0; i < 60 && !boot.includes('dashboard'); i++) await sleep(200);

// Two caps on purpose. max_tokens trips first, so the task dies on it; max_usd
// is set just above what the stream spends, so a later span is what finally
// breaks it. That is the case where attributing "the first breached cap"
// instead of "the cap these tokens crossed" reports the wrong thing.
const task = (
  await run(['task', 'new', '--name', 'measure', '--max-tokens', '100', '--max-usd', '0.0002'])
).out.trim();

const send = () =>
  fetch('http://127.0.0.1:4100/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agentcap-task': task,
      'x-agentcap-agent': 'claude-code',
    },
    body: JSON.stringify({ model: 'demo-small', stream: true }),
  }).then((r) => r.text());

const breachOf = (text) => {
  const line = text.split('\n').find((l) => l.includes('budget_exceeded'));
  if (line === undefined) return text.slice(0, 120);
  try {
    return JSON.parse(line.replace(/^data: /, ''));
  } catch {
    return line;
  }
};

// First request trips the cap mid-stream.
const first = await send();
await sleep(400);

// Snapshot the spend at the moment the cap fired, before any OTel span lands.
// This is the "tokens before the cap" half of the headline; the other half is
// whatever arrives afterwards.
const atBreach = await (await fetch('http://127.0.0.1:4102/api/state')).json();
const before = atBreach.tasks.find((t) => t.id === task);

// Then three spans against the dead task: real usage, arriving after the cap.
const otlp = (prompt, completion) =>
  fetch('http://127.0.0.1:4101/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'claude-code' } },
              { key: 'agentcap.task_id', value: { stringValue: task } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'd'.repeat(32),
                  spanId: Math.random().toString(16).slice(2, 18).padEnd(16, '0'),
                  name: 'anthropic.chat',
                  startTimeUnixNano: String(Date.now() * 1e6 - 800_000_000),
                  endTimeUnixNano: String(Date.now() * 1e6),
                  attributes: [
                    { key: 'gen_ai.request.model', value: { stringValue: 'demo-small' } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: String(prompt) } },
                    { key: 'gen_ai.usage.output_tokens', value: { intValue: String(completion) } },
                  ],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    }),
  });

await otlp(300, 120);
await sleep(250);
await otlp(280, 90);
await sleep(250);
await otlp(250, 80);
await sleep(600);

// One more proxy request: admission must refuse without adding tokens.
const refused = await send();
await sleep(400);

const state = await (await fetch('http://127.0.0.1:4102/api/state')).json();
const row = state.tasks.find((t) => t.id === task);

// Read the late_usage payloads straight out of the DB. The attribution fields are
// the point of the run, so they are reported rather than inferred from totals.
const { default: Database } = await import('better-sqlite3');
const db = new Database(join(root, '.agentcap', 'agentcap.db'), { readonly: true });
const late = db
  .prepare("SELECT payload FROM events WHERE type = 'late_usage' ORDER BY ts, rowid")
  .all()
  .map((r) => JSON.parse(r.payload));
db.close();

console.log(
  JSON.stringify(
    {
      breachBody: breachOf(first),
      refusedBody: breachOf(refused),
      cap: 100,
      tokensAtBreach: before?.tokens,
      status: row?.status,
      breachReason: row?.breachReason,
      tokensTotal: row?.tokens,
      lateTokens: row?.lateTokens,
      lateSpans: row?.lateSpans,
      late: late.map((l) => ({
        tokens: l.tokens,
        wouldExceed: l.wouldExceed,
        capCrossed: l.capCrossed,
        alreadyOver: l.alreadyOver,
        arrivedAfterMs: l.arrivedAfterMs,
      })),
      steps: row?.steps,
      taskCount: state.tasks.length,
      untrackedSteps: state.untracked.steps,
    },
    null,
    2,
  ),
);

server.kill('SIGINT');
up.close();
await sleep(600);
rmSync(root, { recursive: true, force: true });
