// Records docs/dashboard.png and docs/demo.gif from a real dashboard.
//
// Headless --screenshot is not usable here: the page holds an open EventSource,
// so Chrome never considers the load finished and never fires the screenshot.
// This drives Chrome over CDP instead, and pushes real proxy traffic between
// frames so the GIF actually moves.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CHROME_PATH wins, then the platform's usual locations. A docs script, so it
// never blocks users — but it does block CI, so the failure names the override.
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((c) => typeof c === 'string' && c !== '');
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `no Chrome found — set CHROME_PATH to a Chrome/Chromium binary (tried ${candidates.length} locations)`,
  );
}
const CHROME = findChrome();
const DASH = 'http://127.0.0.1:4102/';
const PROXY = 'http://127.0.0.1:4100/v1/chat/completions';
const FRAMES = 18;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return res;
    } catch {}
    await sleep(500);
  }
  throw new Error(`never came up: ${url}`);
}

// 1. Demo install (fixed ports, so nothing else may be listening).
const demo = spawn(process.execPath, [new URL('./gif-demo.mjs', import.meta.url).pathname], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let demoOut = '';
demo.stdout.on('data', (d) => (demoOut += d));
await waitFor(DASH);

// The demo prints the task ids after its own traffic; wait for them so captured
// traffic is attributed to real tasks instead of all landing in untracked.
for (let i = 0; i < 100 && !/DIGEST=\S+/.test(demoOut); i++) await sleep(250);
const ytId = /YT=(\S+)/.exec(demoOut)?.[1] ?? null;
const taskId = /TRADE=(\S+)/.exec(demoOut)?.[1] ?? null;
const digestId = /DIGEST=(\S+)/.exec(demoOut)?.[1] ?? null;

// 2. Chrome with a debug port.
const profile = mkdtempSync(join(tmpdir(), 'agentcap-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1240,1000',
    '--remote-debugging-port=9222',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const version = await (await waitFor('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  const resolve = pending.get(msg.id);
  if (resolve !== undefined) {
    pending.delete(msg.id);
    resolve(msg.result ?? msg.error);
  }
};
const call = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
await call('Page.enable', {}, sessionId);
await call(
  'Emulation.setDeviceMetricsOverride',
  { width: 1240, height: 1000, deviceScaleFactor: 1, mobile: false },
  sessionId,
);
await call('Page.navigate', { url: DASH }, sessionId);
await sleep(1500);

const shoot = async (path) => {
  const shot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
};

const send = (task, agent) =>
  fetch(PROXY, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agentcap-agent': agent,
      ...(task ? { 'x-agentcap-task': task } : {}),
    },
    body: JSON.stringify({ model: 'demo-small', stream: true }),
  }).then((r) => r.text());

mkdirSync('docs', { recursive: true });

// 3. Frames with live traffic between them. The still is taken part-way in, once
// there are real numbers and a task has already breached its cap.
const out = mkdtempSync(join(tmpdir(), 'agentcap-frames-'));
for (let i = 0; i < FRAMES; i++) {
  await Promise.all([
    ytId === null ? send(null, 'claude-code') : send(ytId, 'claude-code'),
    taskId === null ? send(null, 'opencode') : send(taskId, 'opencode'),
    digestId === null ? send(null, 'codex') : send(digestId, 'codex'),
    send(null, 'n8n'),
  ]);
  await sleep(320);
  const frame = join(out, `${String(i).padStart(3, '0')}.png`);
  await shoot(frame);
}

// The still is taken after the traffic drains, so every row has its final
// numbers instead of the zeros a streaming row carries.
await sleep(2500);
await shoot('docs/dashboard.png');

// 4. GIF.
await new Promise((resolve, reject) => {
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      '3',
      '-i',
      join(out, '%03d.png'),
      '-vf',
      'scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer',
      '-loop',
      '0',
      'docs/demo.gif',
    ],
    { stdio: 'inherit' },
  );
  ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
});

const gif = readFileSync('docs/demo.gif');
console.log(`dashboard.png + demo.gif written (${Math.round(gif.length / 1024)}KB gif)`);

ws.close();
chrome.kill();
demo.kill('SIGINT');
await sleep(600);
rmSync(profile, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
process.exit(0);
