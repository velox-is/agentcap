import { createServer, type Server } from 'node:http';

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>agentcap</title>
<style>
  body { margin:0; background:#111111; color:#F5F4F1; font:14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; padding:32px; }
  h1 { font-size:14px; font-weight:500; letter-spacing:.12em; text-transform:uppercase; margin:0 0 16px; }
  p { color:#8a8a86; margin:0 0 8px; }
</style></head>
<body><h1>agentcap</h1><p>dashboard placeholder — milestone 5</p><p>proxy :4100 · otel :4101 · dashboard :4102</p></body></html>`;

export function createDashboardServer(): Server {
  return createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'dashboard' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PLACEHOLDER);
  });
}
