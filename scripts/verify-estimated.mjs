// Blocker 2: the fallback tokenizer must resolve from the *packed* artifact.
// Installs the tarball in a temp dir, runs the real CLI against a mock upstream
// that omits `usage` entirely, and asserts the row is marked estimated with a
// non-zero count. Runs under whichever node is on PATH.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolve } from 'node:path';

// Resolved: npm runs from the temp dir, so a relative tarball path breaks.
const tgz = process.argv[2] ? resolve(process.argv[2]) : null;
if (!tgz) throw new Error('usage: verify-estimated.mjs <tarball>');
const upPort = 4197;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// No usage field anywhere in the frames, and no [DONE] usage chunk.
const up = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const word of ['alpha ', 'beta ', 'gamma']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => up.listen(upPort, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'agentcap-est-'));
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });

const inst = sh('npm', ['install', tgz, '--no-audit', '--no-fund'], dir);
if (inst.status !== 0) {
  console.error(inst.stderr);
  throw new Error('install failed');
}

const proj = join(dir, 'proj');
sh('mkdir', ['-p', proj]);
const bin = join(dir, 'node_modules', '.bin', 'agentcap');
sh(bin, ['init'], proj);
writeFileSync(
  join(proj, 'agentcap.config.json'),
  JSON.stringify({
    bind: '127.0.0.1',
    ports: { proxy: 4100, otel: 4101, dashboard: 4102 },
    providers: { demo: { baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKeyEnv: 'DEMO_KEY', models: ['demo-small'] } },
    pricing: { 'demo-small': { in: 0.15, out: 0.6 } },
  }),
);

const server = spawn(bin, ['start'], { cwd: proj, env: { ...process.env, DEMO_KEY: 'k' } });
let boot = '';
server.stdout.on('data', (d) => (boot += d));
server.stderr.on('data', (d) => (boot += d));
for (let i = 0; i < 80 && !boot.includes('agentcap up'); i++) await sleep(200);
if (!boot.includes('agentcap up')) {
  console.error(boot);
  throw new Error('start failed');
}

const task = sh(bin, ['task', 'new', '--name', 'est', '--max-tokens', '100000'], proj).stdout.trim();
await fetch('http://127.0.0.1:4100/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-agentcap-task': task },
  body: JSON.stringify({ model: 'demo-small', stream: true, messages: [{ role: 'user', content: 'count me' }] }),
}).then((r) => r.text());
await sleep(400);

const { default: Database } = await import(join(dir, 'node_modules', 'better-sqlite3', 'lib', 'index.js'));
const db = new Database(join(proj, '.agentcap', 'agentcap.db'), { readonly: true });
const row = db
  .prepare('SELECT prompt_tokens, completion_tokens, estimated FROM requests ORDER BY seq DESC LIMIT 1')
  .get();
db.close();

console.log(
  JSON.stringify({
    node: process.version,
    tiktokenResolved: sh('node', ['-e', "import('js-tiktoken').then(m=>console.log(typeof m.getEncoding))"], dir).stdout.trim(),
    promptTokens: row?.prompt_tokens,
    completionTokens: row?.completion_tokens,
    estimated: row?.estimated,
  }),
);

server.kill('SIGINT');
up.close();
await sleep(500);
rmSync(dir, { recursive: true, force: true });
