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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(here, '..', '..', 'client');
const MODULES_DIR = path.join(here, '..', '..', 'modules');
const FIRMWARE_DIR = path.join(here, '..', '..', 'firmware-assets');
// A sibling checkout, not a copy — overridable in case nodigraph lives
// somewhere else on this machine.
const NODIGRAPH_CLIENT_DIR = process.env.NODIGRAPH_CLIENT_DIR || path.join(here, '..', '..', '..', 'nodigraph', 'client');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8090;

// The embedded editor requests /api/version and labels it "nodigraph".
// Report the editor's revision, not noditron's: locally it comes from the
// sibling checkout; Docker stamps the exact vendored commit before removing
// that checkout. No copied editor sources need updating in this repo.
function readNodigraphBuildInfo() {
  const root = path.resolve(NODIGRAPH_CLIENT_DIR, '..');
  let stamped = {};
  try {
    stamped = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
  } catch {
    // Local checkouts do not need a build stamp.
  }
  let commit = stamped.commit;
  if ((!commit || commit === 'unknown') && fs.existsSync(path.join(root, '.git'))) {
    try {
      commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', windowsHide: true, timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // A plain client directory can still be served without Git installed.
    }
  }
  return {
    commit: commit || 'unknown',
    builtAt: stamped.builtAt || null,
    revision: process.env.K_REVISION || null,
    service: process.env.K_SERVICE || null,
    startedAt: new Date().toISOString(),
  };
}

const NODIGRAPH_BUILD_INFO = readNodigraphBuildInfo();

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
    // Every response carries a validator, and the sources carry none at
    // all. Without either, a browser is free to decide for itself how long
    // a file stays fresh — and Chrome, given no Cache-Control, no ETag and
    // no Last-Modified, will happily keep serving an ES module out of its
    // own cache without ever asking again. An edit to client/src then
    // reaches a reloaded page not at all: the page runs the build from
    // whenever it first loaded, and every change looks like it did
    // nothing. (That cost a long debugging session once: fixes verified
    // against real hardware, with the browser quietly running the code
    // from before them.)
    //
    // This server exists to develop against, so the sources are never
    // cached and everything else revalidates by mtime.
    const stamp = `W/"${data.length.toString(16)}-${Number(new Date().getTime()).toString(16)}"`;
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
      ETag: stamp,
    });
    res.end(data);
  });
}

// In-memory only, on purpose — this is a prototype server for trying the
// bool/AND/LED runtime out, not a persistence story of its own yet. A
// restart loses whatever's open, same as nodigraph's own server would if
// its persistence were disabled (see nodigraph's own PERSISTENCE_DISABLED).
let savedProject = null;

function readBundledModule(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) return null;
  const filePath = path.join(MODULES_DIR, name, 'noditron.module.json');
  if (!filePath.startsWith(MODULES_DIR)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function handleListModules(res) {
  let names = [];
  try {
    names = fs
      .readdirSync(MODULES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    names = [];
  }

  const modules = names
    .map((name) => ({ name, manifest: readBundledModule(name) }))
    .filter((entry) => entry.manifest && entry.manifest.noditronModule === 1)
    .map(({ name, manifest }) => ({
      owner: 'local',
      repo: 'bundled',
      ref: 'local',
      path: `modules/${name}/noditron.module.json`,
      manifest,
    }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(modules));
}

function handleGetModule(name, res) {
  const manifest = readBundledModule(name);
  if (!manifest || manifest.noditronModule !== 1) {
    res.writeHead(404);
    res.end('Module not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(manifest));
}

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

  if (urlPath === '/api/version' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(NODIGRAPH_BUILD_INFO));
    return;
  }

  if (urlPath === '/api/project' && req.method === 'GET') {
    handleGetProject(res);
    return;
  }
  if (urlPath === '/api/project' && req.method === 'PUT') {
    handlePutProject(req, res);
    return;
  }
  if (urlPath === '/api/modules' && req.method === 'GET') {
    handleListModules(res);
    return;
  }
  if (urlPath.startsWith('/api/modules/') && req.method === 'GET') {
    handleGetModule(decodeURIComponent(urlPath.slice('/api/modules/'.length)), res);
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
  if (urlPath.startsWith('/firmware-assets/')) {
    serveFrom(FIRMWARE_DIR, urlPath.slice('/firmware-assets'.length), res);
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
