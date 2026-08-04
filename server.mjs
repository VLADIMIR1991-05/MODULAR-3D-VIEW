import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import worker from './src/worker.js';

const root = new URL('./public/', import.meta.url).pathname;
const env = { ...process.env };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

env.ASSETS = { async fetch(request) {
  const url = new URL(request.url);
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const path = normalize(join(root, requested));
  if (!path.startsWith(root)) return new Response('Forbidden', { status: 403 });
  try { const info = await stat(path); if (!info.isFile()) throw new Error('not file'); return new Response(await readFile(path), { headers: { 'content-type': mime[extname(path)] || 'application/octet-stream' } }); }
  catch { return new Response(await readFile(join(root, 'index.html')), { headers: { 'content-type': mime['.html'] } }); }
} };

createServer(async (req, res) => {
  try {
    const origin = env.APP_BASE_URL || `http://${req.headers.host}`;
    const request = new Request(new URL(req.url, origin), { method: req.method, headers: req.headers, body: ['GET','HEAD'].includes(req.method) ? undefined : req, duplex: 'half' });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'server_error', message: error.message })); }
}).listen(Number(env.PORT || 3000), '0.0.0.0', () => console.log(`MODURAL-3D VIEW running on port ${env.PORT || 3000}`));
