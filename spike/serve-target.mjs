/**
 * Tiny static target server for smoke-testing the CLI against a local page.
 * Serves spike/target/<file> on <port> and answers POST /api/social/post 200.
 *
 * Run:  node spike/serve-target.mjs dense.html 4175
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || 'dense.html';
const port = Number(process.argv[3] || 4175);
const html = readFileSync(join(__dir, 'target', file), 'utf8');

createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/social/post')) {
    console.error('[serve] POST /api/social/post');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
}).listen(port, () => console.error(`[serve] ${file} on http://localhost:${port}`));
