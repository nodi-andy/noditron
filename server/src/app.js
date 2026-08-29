// noditron's own server — separate from nodigraph's (server/src/app.js
// over there) in every way except the shape it happens to copy: this file
// never imports anything from nodigraph, and nodigraph's repo is never
// written to by anything here. It serves two things:
//   - noditron's own client (this project's UI: the block palette and the
//     bool/AND/LED runtime — see client/src/).
//   - nodigraph's client, read-only, at /nodigraph/ — the actual diagram
//     editor (canvas, ports, wires, Inspector) runs unmodified from there.
//     client/index.html loads nodigraph's own main.js from that path
//     directly; noditron's own bootstrap (client/src/main.js) waits for it
//     to set up `window.nodigraph` (see nodigraph's client/src/main.js —
//     a generic embedding hook, not something added for noditron
//     specifically) and takes it from there.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(here, '..', '..', 'client');
// A sibling checkout, not a copy — overridable in case nodigraph lives
// somewhere else on this machine.
const NODIGRAPH_CLIENT_DIR = process.env.NODIGRAPH_CLIENT_DIR || path.join(here, '..', '..', '..', 'nodigraph', 'client');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8090;

// Same reasoning as nodigraph's own PERSISTENCE_DISABLED (see that
// server's own comment on it) — `savedProject` below is one variable
// shared by every request this process handles, so deploying this file
// as-is anywhere shared (Cloud Run included) would turn it into a single
// document every visitor silently reads and writes. In-memory-only means
// there's no disk file to leak *across restarts* the way nodigraph's own
// unguarded persistence would, but *within* one running instance's
// lifetime, concurrent visitors would still share it. The Dockerfile sets
// this to disable persistence by default; local `node src/app.js` keeps
// its current single-user convenience since nothing sets it there.
const PERSISTENCE_DISABLED =
  process.env.NODITRON_DISABLE_PERSISTENCE === 'true' || process.env.NODITRON_DISABLE_PERSISTENCE === '1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function serveFrom(root, urlPath, res) {
  const pathOnly = urlPath.split('?')[0];
  const relative = pathOnly === '/' ? '/index.html' : pathOnly;
  const filePath = path.join(root, decodeURIComponent(relative));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// In-memory only, on purpose — this is a prototype server for trying the
// bool/AND/LED runtime out, not a persistence story of its own yet. A
// restart loses whatever's open, same as nodigraph's own server would if
// its persistence were disabled (see nodigraph's own PERSISTENCE_DISABLED).
let savedProject = null;

function handleGetProject(res) {
  if (PERSISTENCE_DISABLED) {
    // Same shape as "nothing saved yet" below — nodigraph's own client
    // (see its model/store.js) already treats that as "start fresh" and
    // falls back to its own per-browser localStorage, so a disabled
    // deployment needs no special case on the client side at all.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('null');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(savedProject ? JSON.stringify(savedProject) : 'null');
}

function handlePutProject(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (PERSISTENCE_DISABLED) {
      // Accepted but deliberately dropped — nothing reaches this
      // process's shared memory, nothing reaches another visitor. The
      // browser's own localStorage already holds this edit.
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      savedProject = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }
    res.writeHead(204);
    res.end();
  });
}

const server = http.createServer((req, res) => {
  const [urlPath] = req.url.split('?');

  if (urlPath === '/api/project' && req.method === 'GET') {
    handleGetProject(res);
    return;
  }
  if (urlPath === '/api/project' && req.method === 'PUT') {
    handlePutProject(req, res);
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (urlPath.startsWith('/nodigraph/')) {
    serveFrom(NODIGRAPH_CLIENT_DIR, urlPath.slice('/nodigraph'.length), res);
    return;
  }
  serveFrom(CLIENT_DIR, urlPath, res);
});

// nodigraph's own main.js (loaded unmodified from /nodigraph/, see above)
// opens a WebSocket to its own origin for live multi-client sync — this
// just accepts the connection so that doesn't reconnect-loop forever in
// the console. Nothing is ever broadcast: noditron isn't a multi-client
// product (yet), so there's nothing for it to relay.
const wss = new WebSocketServer({ server });
wss.on('connection', () => {});

server.listen(PORT, () => {
  console.log(`noditron server running at http://localhost:${PORT}`);
  console.log(`nodigraph client vendored (read-only) from ${NODIGRAPH_CLIENT_DIR}`);
  console.log(
    PERSISTENCE_DISABLED
      ? 'Persistence disabled (NODITRON_DISABLE_PERSISTENCE) — nothing is stored server-side.'
      : 'Project data held in memory only (this process, not written to disk).',
  );
});
