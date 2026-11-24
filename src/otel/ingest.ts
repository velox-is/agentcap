import { createServer, type Server } from 'node:http';

export function createOtelServer(): Server {
  return createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'otel' }));
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/traces' || req.url === '/v1/logs')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ partialSuccess: {} }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: req.url }));
  });
}
