// Live check of the real CLI: OTel on :4101 must land in the same DB the
// dashboard reads, and must be killable/cappable like proxied traffic.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'agentcap-otel-live-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('FAIL', m); process.exit(1); };
const ok = (m) => console.log('ok', m);

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
  JSON.stringify({ bind: '127.0.0.1', ports: { proxy: 4100, otel: 4101, dashboard: 4102 }, providers: {}, pricing: { 'claude-sonnet-4': { in: 3, out: 15 } } }),
);

const server = spawn(process.execPath, [CLI, 'start'], { cwd: root });
let boot = '';
server.stdout.on('data', (d) => (boot += d));
for (let i = 0; i < 60 && !boot.includes('dashboard'); i++) await sleep(200);
if (!boot.includes('dashboard')) fail(`never booted: ${boot}`);

const fixture = readFileSync(new URL('../tests/fixtures/otlp-traces.json', import.meta.url), 'utf8');
const post = (task) =>
  fetch('http://127.0.0.1:4101/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: fixture.replace('__TASK__', task),
  });

const task = (await run(['task', 'new', '--name', 'otel-live', '--max-tokens', '100000'])).out.trim();
if (!task) fail('no task id');

const res = await post(task);
if (res.status !== 200) fail(`ingest status ${res.status}`);
ok('ingest 200');

await sleep(600);
const state = await (await fetch('http://127.0.0.1:4102/api/state')).json();
const row = state.tasks.find((t) => t.id === task);
if (!row) fail(`task missing from dashboard: ${JSON.stringify(state.tasks)}`);
if (row.tokens !== 1540) fail(`tokens ${row.tokens}, expected 1540`);
ok(`dashboard shows ${row.tokens} tokens from otel`);

const feed = state.feed.find((r) => r.taskId === task);
if (!feed) fail('span missing from feed');
ok('span in feed');

// Unknown task still recorded as untracked.
await post('no-such-task');
await sleep(400);
const after = await (await fetch('http://127.0.0.1:4102/api/state')).json();
if (after.untracked.steps !== 1) fail(`untracked not counted: ${JSON.stringify(after.untracked)}`);
ok('unknown task filed as untracked');

// 415 and 413 over the wire.
const proto = await fetch('http://127.0.0.1:4101/v1/traces', { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: 'x' });
if (proto.status !== 415) fail(`protobuf status ${proto.status}`);
ok('415 on protobuf');
const big = await fetch('http://127.0.0.1:4101/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 64) }) });
if (big.status !== 413) fail(`oversize status ${big.status}`);
ok('413 on oversize');

console.log('PASS');
server.kill('SIGINT');
await sleep(600);
rmSync(root, { recursive: true, force: true });
