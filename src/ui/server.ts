import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import {
  killTask,
  maxSeq,
  recentRequests,
  requestsSince,
  settledRequests,
  taskRollup,
  untrackedRollup,
  type TaskRollup,
} from './queries.js';

export interface DashboardDeps {
  db: Database.Database;
  config: Config;
  now?: () => number;
}

// Rows rendered at once. Above this the table reorders faster than it can be
// read, so the top 100 by burn are shown and the count of the rest is printed.
const MAX_TASK_ROWS = 100;

// One page, tables only. The client never polls: the server pushes over SSE and
// the client keeps the last 500 rows in a ring buffer so a long session cannot
// eat the tab.
const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentcap</title>
<style>
  :root { --fg:#F5F4F1; --bg:#111111; --dim:#8a8a86; --line:#2a2a28; --warn:#e8b64c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; padding:24px; }
  h1 { font-size:13px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; margin:0 0 4px; }
  h2 { font-size:11px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--dim); margin:28px 0 8px; }
  .sub { color:var(--dim); margin:0 0 20px; }
  .more { color:var(--dim); font-size:11px; margin:6px 0 0; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th { text-align:left; font-weight:500; color:var(--dim); font-size:11px; letter-spacing:.08em; text-transform:uppercase; border-bottom:1px solid var(--line); padding:6px 8px; }
  td { padding:5px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td.name { white-space:normal; }
  .num { text-align:right; }
  .dim { color:var(--dim); }
  .warn { color:var(--warn); }
  .idle { color:var(--dim); padding:10px 8px; }
  button { font:inherit; background:transparent; color:var(--fg); border:1px solid var(--line); padding:2px 8px; cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--fg); }
  button:disabled { color:var(--dim); cursor:default; }
  .banner { border:1px solid var(--warn); color:var(--warn); padding:10px 12px; margin:0 0 20px; }
  .banner a { color:var(--warn); }
  .empty { border:1px dashed var(--line); padding:16px; margin:0 0 20px; }
  .empty p { margin:0 0 8px; }
  pre { margin:0; padding:8px 10px; background:#1a1a19; border:1px solid var(--line); overflow-x:auto; }
  .status-killed, .status-stuck { color:var(--warn); }
</style></head>
<body>
<h1>agentcap</h1>
<p class="sub" id="ep">proxy http://127.0.0.1:4100 · local only</p>

<div id="banner"></div>
<div id="empty"></div>

<h2>tasks</h2>
<table id="tasksTable">
  <thead><tr>
    <th scope="col">task</th><th scope="col">status</th>
    <th scope="col" class="num">tokens</th><th scope="col" class="num">cost</th>
    <th scope="col" class="num">steps</th><th scope="col" class="num">elapsed</th>
    <th scope="col">kill</th>
  </tr></thead>
  <tbody id="tasks"><tr><td class="idle" colspan="7">no tasks yet</td></tr></tbody>
</table>
<p class="more" id="more"></p>

<h2>requests</h2>
<table>
  <thead><tr>
    <th scope="col">time</th><th scope="col">agent</th><th scope="col">model</th>
    <th scope="col" class="num">tokens</th><th scope="col" class="num">cost</th>
    <th scope="col">status</th><th scope="col">task</th>
  </tr></thead>
  <tbody id="feed" aria-live="polite"><tr><td class="idle" colspan="7">waiting for traffic</td></tr></tbody>
</table>

<script>
(function () {
  var MAX = 500;
  // Ordering is throttled and frozen; contents are not. A new or terminal row
  // merges on the tick it arrives, but the table only re-sorts every 2s and
  // stops re-sorting entirely while the pointer is over it or a kill button has
  // focus — otherwise the button moves out from under the cursor mid-click.
  var SORT_EVERY = 2000;
  var feed = [];
  var taskRows = [];
  var order = [];
  var lastSort = 0;
  var frozen = false;
  var untracked = { tokens:0, usd:0, steps:0, estimated:0, unpriced:0 };
  var providers = 0;

  function esc(v) {
    return String(v).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }
  function tokens(n, est) { return (est ? '~' : '') + n.toLocaleString(); }
  function usd(v, unpriced) {
    if (unpriced) return '!';
    return '$' + v.toFixed(4);
  }
  function elapsed(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    return m + 'm' + (s % 60) + 's';
  }

  function renderBanner() {
    var el = document.getElementById('banner');
    if (providers > 0) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="banner">no providers configured — copy ' +
      '<a href="/agentcap.config.example.json">agentcap.config.example.json</a> to ' +
      'agentcap.config.json and add one.</div>';
  }

  function renderEmpty() {
    var el = document.getElementById('empty');
    if (feed.length > 0) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="empty"><p>Point your agent\'s base URL at the proxy and it shows up here, no code change.</p>' +
      '<pre>export OPENAI_BASE_URL=http://127.0.0.1:4100/v1</pre></div>';
  }

  // Order maintenance: a full sort at most every SORT_EVERY while not frozen;
  // otherwise only append ids we have not seen and drop ids that are gone, so
  // the rows present stay exactly where they were.
  function syncOrder() {
    var present = {};
    var i;
    for (i = 0; i < taskRows.length; i++) present[taskRows[i].id] = true;

    if (!frozen && Date.now() - lastSort >= SORT_EVERY) {
      order = taskRows.slice().sort(function (a, b) { return b.tokens - a.tokens; })
        .map(function (t) { return t.id; });
      lastSort = Date.now();
      return;
    }

    var seen = {};
    var next = [];
    for (i = 0; i < order.length; i++) {
      if (present[order[i]] === true && seen[order[i]] !== true) {
        next.push(order[i]);
        seen[order[i]] = true;
      }
    }
    for (i = 0; i < taskRows.length; i++) {
      var id = taskRows[i].id;
      if (seen[id] !== true) { next.push(id); seen[id] = true; }
    }
    order = next;
  }

  function renderTasks() {
    var body = document.getElementById('tasks');
    var more = document.getElementById('more');
    if (taskRows.length === 0) {
      body.innerHTML = '<tr><td class="idle" colspan="7">no tasks yet — agentcap task new --name demo</td></tr>';
      more.textContent = '';
      return;
    }

    syncOrder();

    var byId = {};
    var i;
    for (i = 0; i < taskRows.length; i++) byId[taskRows[i].id] = taskRows[i];

    var shown = Math.min(order.length, ${MAX_TASK_ROWS});
    var html = '';
    for (i = 0; i < shown; i++) {
      var t = byId[order[i]];
      if (t === undefined) continue;
      var share = t.steps > 0 ? Math.round((t.estimated / t.steps) * 100) : 0;
      var dead = t.status === 'killed' || t.status === 'stuck';
      // Why it stopped, not the verdict currently true of it: a task killed on
      // max_seconds must not read as a token breach.
      var why = dead ? (t.breachReason || t.status) : t.status;
      html += '<tr>' +
        '<td class="name">' + esc(t.name) + '</td>' +
        '<td class="status-' + esc(t.status) + '">' + esc(why) + '</td>' +
        '<td class="num">' + tokens(t.tokens, share > 0) +
          (share > 0 ? ' <span class="dim">est ' + share + '%</span>' : '') +
          (t.lateTokens > 0 ? ' <span class="warn">+' + t.lateTokens.toLocaleString() +
            ' late</span>' : '') + '</td>' +
        '<td class="num">' + usd(t.usd, t.unpriced > 0) + '</td>' +
        '<td class="num">' + t.steps + '</td>' +
        '<td class="num dim">' + elapsed(t.elapsedMs) + '</td>' +
        '<td><button data-kill="' + esc(t.id) + '" aria-label="kill task ' + esc(t.name) + '"' +
          (dead ? ' disabled' : '') + '>kill</button></td>' +
        '</tr>';
    }
    // Untracked pseudo-row: always present, so it is impossible to miss.
    var u = untracked;
    html += '<tr>' +
      '<td class="name dim">untracked</td>' +
      '<td class="dim">—</td>' +
      '<td class="num">' + tokens(u.tokens, u.estimated > 0) + '</td>' +
      '<td class="num">' + usd(u.usd, u.unpriced > 0) + '</td>' +
      '<td class="num">' + u.steps + '</td>' +
      '<td class="num dim">—</td>' +
      '<td class="dim">uncapped</td>' +
      '</tr>';
    body.innerHTML = html;
    more.textContent = order.length > shown
      ? 'showing ' + shown + ' of ' + order.length + ' by burn'
      : '';
  }

  function renderFeed() {
    var body = document.getElementById('feed');
    if (feed.length === 0) {
      body.innerHTML = '<tr><td class="idle" colspan="7">waiting for traffic</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < feed.length; i++) {
      var r = feed[i];
      var when = new Date(r.ts).toLocaleTimeString();
      html += '<tr>' +
        '<td class="dim">' + esc(when) + '</td>' +
        '<td>' + esc(r.agent) + '</td>' +
        '<td class="dim">' + esc(r.model) + '</td>' +
        '<td class="num">' + tokens(r.tokens, r.estimated === 1) + '</td>' +
        '<td class="num">' + usd(r.usd, r.unpriced === 1) + '</td>' +
        '<td class="status-' + esc(r.status) + '">' + esc(r.status) +
          (r.late === 1
            ? ' <span class="warn">late' +
              (r.lateAfterMs === null ? ' ?' : ' +' + Math.round(r.lateAfterMs / 1000) + 's') +
              '</span>'
            : '') + '</td>' +
        '<td class="dim">' + esc(r.taskId === null ? '—' : r.taskId.slice(0, 8)) + '</td>' +
        '</tr>';
    }
    body.innerHTML = html;
  }

  function render() { renderBanner(); renderEmpty(); renderTasks(); renderFeed(); }

  function addFeed(rows) {
    for (var i = rows.length - 1; i >= 0; i--) feed.unshift(rows[i]);
    if (feed.length > MAX) feed.length = MAX;
  }

  function apply(msg) {
    if (msg.type === 'state') {
      providers = msg.providers;
      taskRows = msg.tasks;
      untracked = msg.untracked;
      feed = msg.feed.slice(0, MAX);
      lastSort = 0;
    } else if (msg.type === 'tick') {
      taskRows = msg.tasks;
      untracked = msg.untracked;
      if (msg.feed.length > 0) addFeed(msg.feed);
      // Merge terminal rows into entries we already hold, by id: the feed is
      // insert-driven, so a finished request needs its status overwritten.
      if (msg.settled && msg.settled.length > 0) {
        for (var s = 0; s < msg.settled.length; s++) {
          var row = msg.settled[s];
          for (var f = 0; f < feed.length; f++) {
            if (feed[f].id === row.id) { feed[f] = row; break; }
          }
        }
      }
    }
    render();
  }

  var table = document.getElementById('tasksTable');
  table.addEventListener('mouseenter', function () { frozen = true; });
  table.addEventListener('mouseleave', function () { frozen = false; lastSort = 0; renderTasks(); });
  table.addEventListener('focusin', function () { frozen = true; });
  table.addEventListener('focusout', function () { frozen = false; lastSort = 0; renderTasks(); });

  table.addEventListener('click', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-kill');
    if (!id) return;
    e.target.disabled = true;
    fetch('/api/tasks/' + encodeURIComponent(id) + '/kill', { method: 'POST' });
  });

  var src = new EventSource('/api/stream');
  src.onmessage = function (e) { apply(JSON.parse(e.data)); };
  src.onerror = function () { document.getElementById('ep').textContent = 'stream lost — reconnecting'; };
})();
</script>
</body></html>`;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

interface Client {
  res: ServerResponse;
  cursor: number;
  lastKey: string;
}

export function createDashboardServer(deps: DashboardDeps): Server {
  const now = deps.now ?? Date.now;
  const { db, config } = deps;

  // One timer for every open dashboard, not one per connection: two tabs must
  // not double the query rate. Each client keeps its own cursor.
  const clients = new Set<Client>();
  let timer: NodeJS.Timeout | null = null;

  function withElapsed(task: TaskRollup) {
    return { ...task, elapsedMs: now() - task.createdAt };
  }

  function snapshot(): unknown {
    return {
      type: 'state',
      providers: Object.keys(config.providers).length,
      tasks: taskRollup(db).map(withElapsed),
      untracked: untrackedRollup(db),
      feed: recentRequests(db, 200),
    };
  }

  // Shared work once per tick: the task table and the untracked bucket are the
  // same for every client. Per client, only the cursor moves.
  function tick(): void {
    if (clients.size === 0) return;
    const tasks = taskRollup(db).map(withElapsed);
    const untracked = untrackedRollup(db);
    const shared = JSON.stringify([tasks, untracked]);

    for (const client of clients) {
      const fresh = requestsSince(db, client.cursor, 200);
      if (fresh.length > 0) client.cursor += fresh.length;
      // Terminal rows for entries the client still holds as `streaming`, so the
      // feed does not lie about a request that already finished.
      const settled = settledRequests(db, Math.max(0, client.cursor - 500), 200);
      const key = JSON.stringify([shared, settled.map((r) => [r.id, r.status])]);
      if (fresh.length === 0 && key === client.lastKey) continue;
      client.lastKey = key;
      client.res.write(
        `data: ${JSON.stringify({ type: 'tick', tasks, untracked, feed: fresh, settled })}\n\n`,
      );
    }
  }

  function stream(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);

    const client: Client = { res, cursor: maxSeq(db), lastKey: '' };
    clients.add(client);
    if (timer === null) timer = setInterval(tick, 250);

    res.on('close', () => {
      clients.delete(client);
      if (clients.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    });
  }

  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (path === '/health') {
      // Constant shape: no provider names, no keys.
      send(res, 200, { ok: true, service: 'dashboard' });
      return;
    }

    if (path === '/agentcap.config.example.json') {
      // The banner links here; read it from the project root so the file on disk
      // stays the single source of truth.
      const file = 'agentcap.config.example.json';
      if (existsSync(file)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(readFileSync(file, 'utf8'));
      } else {
        send(res, 404, { error: 'not_found' });
      }
      return;
    }

    if (path === '/api/state') {
      send(res, 200, snapshot());
      return;
    }

    if (path === '/api/stream') {
      stream(res);
      return;
    }

    const kill = /^\/api\/tasks\/([^/]+)\/kill$/.exec(path);
    if (kill !== null && req.method === 'POST') {
      const id = decodeURIComponent(kill[1] ?? '');
      if (!killTask(db, id)) {
        send(res, 404, { error: 'unknown_task', task: id });
        return;
      }
      send(res, 200, { killed: id });
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
}
