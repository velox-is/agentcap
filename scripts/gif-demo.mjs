// Drives a demo install for the README GIF: mock upstream, real proxy traffic,
// a task that breaches its cap. Ports are the fixed ones, so nothing else may be
// listening.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'agentcap-gif-'));
const upPort = 4199;

// Mock upstream: streams a few content frames and a usage frame, then closes.
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
    }, 220);
  });
});
await new Promise((r) => up.listen(upPort, '127.0.0.1', r));

const run = (args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root, ...opts });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

await run(['init']);
writeFileSync(
  join(root, 'agentcap.config.json'),
  JSON.stringify(
    {
      bind: '127.0.0.1',
      ports: { proxy: 4100, otel: 4101, dashboard: 4102 },
      providers: { demo: { baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKeyEnv: 'DEMO_KEY', models: ['demo-small'] } },
      pricing: { 'demo-small': { in: 0.15, out: 0.6 } },
    },
    null,
    2,
  ),
);

const server = spawn(process.execPath, [CLI, 'start'], { cwd: root, env: { ...process.env, DEMO_KEY: 'demo' } });
server.stdout.on('data', (d) => process.stdout.write(d));

await new Promise((r) => setTimeout(r, 1200));

const newTask = async (name, caps) => (await run(['task', 'new', '--name', name, ...caps])).out.trim();
const send = (taskId, agent) =>
  fetch('http://127.0.0.1:4100/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(taskId ? { 'x-agentcap-task': taskId, 'x-agentcap-agent': agent } : {}) },
    body: JSON.stringify({ model: 'demo-small', stream: true }),
  }).then((r) => r.text());

// youtube-pipeline gets a deliberately small cap so it breaches and reads
// `stuck`; the other two stay running.
const yt = await newTask('youtube-pipeline', ['--max-tokens', '400']);
const trade = await newTask('krx-scan', ['--max-usd', '5']);
const digest = await newTask('news-digest', ['--max-tokens', '200000']);

// Untracked traffic first, so the untracked row is populated.
await Promise.all([send(null, 'n8n'), send(null, 'n8n')]);
// Then tracked traffic, looping so the feed and totals keep moving.
for (let i = 0; i < 6; i++) {
  await Promise.all([send(yt, 'claude-code'), send(trade, 'opencode'), send(null, 'n8n')]);
  await new Promise((r) => setTimeout(r, 500));
}

process.stdout.write(`\nDEMO_ROOT=${root}\nYT=${yt}\nTRADE=${trade}\nDIGEST=${digest}\n`);

const stop = () => {
  server.kill('SIGINT');
  up.close();
  setTimeout(() => rmSync(root, { recursive: true, force: true }), 500);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setTimeout(stop, 240_000);
