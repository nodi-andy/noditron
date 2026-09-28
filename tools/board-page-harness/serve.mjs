// A stand-in Logic Module for checking the board page in a real browser
// without a board (see HANDOVER.md, "Save on the board's page"):
//
//   node tools/build-board-site.mjs --out <tmp>
//   node tools/board-page-harness/serve.mjs <tmp>/site 80
//   node tools/board-page-harness/fake-board-ws.mjs 81
//   chrome --headless=new --virtual-time-budget=25000 --enable-logging=stderr --dump-dom http://<this machine's LAN ip>/
//
// From the LAN ip, never localhost: the board's page is plain http from
// 192.168.0.1, an insecure context (no crypto.randomUUID, no clipboard,
// no Web Serial), and localhost would hide exactly that. Port 80 so that
// location.hostname carries no port (the console socket is :81). The
// dumped DOM ends in a <pre id="__diag"> with the level the page opened
// in, the board's state, every toast and every error; /__log lists the
// requests. Never point this at the live noditron server (8090) or a
// board someone is working on.
//
// Serves a built /site the way the firmware does (gzipped files, the
// module JSON under /api/modules, /api/version as a board, a 302 to / for
// anything missing), with a diagnostics block appended to index.html for
// headless checks: window.isSecureContext, whether nodigraph booted, the
// level the page opened in, the root blocks, and every error.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const site = process.argv[2];
const port = Number(process.argv[3] || 8765);
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const log = [];
const DIAG = `<script>
  window.__errs = [];
  addEventListener('error', (e) => window.__errs.push('error: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno));
  addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + ((e.reason && e.reason.stack) || e.reason)));
  window.__toasts = [];
  new MutationObserver(() => { for (const t of document.querySelectorAll('.app-toast')) { const text = t.textContent.trim(); if (!window.__toasts.includes(text)) window.__toasts.push(text); } }).observe(document.body, { childList: true, subtree: true });
  const diag = document.createElement('pre');
  diag.id = '__diag';
  document.body.appendChild(diag);
  setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })), 4000);
  // Then up to the root (the first breadcrumb), so a screenshot shows the
  // board from outside, with whatever the bus scan placed beside it.
  setTimeout(() => document.querySelector('.breadcrumb .crumb')?.click(), 7000);
  setInterval(() => {
    const ng = window.nodigraph;
    const c = ng && ng.project.getContainerBlock();
    const state = (b) => (b && (b.props || []).find((p) => p.name === 'connectionState')) ? b.props.find((p) => p.name === 'connectionState').value : null;
    diag.textContent = JSON.stringify({
      secure: window.isSecureContext,
      nodigraph: typeof ng,
      canvas: !!document.getElementById('scene-canvas'),
      fabs: document.querySelectorAll('.fab').length,
      path: ng ? ng.project.path.length : -1,
      container: c ? c.name : null,
      containerState: state(c),
      rootBlocks: ng ? [...ng.project.rootBlock.children.blocks.values()].map((b) => b.name + ':' + (state(b) || '-')) : null,
      toasts: window.__toasts.map((t) => t.slice(0, 60)),
      // The wires of the level on screen with the colour the host gives
      // each (noditron's window.nodigraphConnectionColor: the value it
      // carries), to see what the runtime computes inside a board.
      wires: ng ? [...ng.project.getLevel().connections.values()].map((c) => {
        const name = (id) => (ng.project.getBlock(id) || ng.project.getContainerBlock() || {}).name;
        const color = window.nodigraphConnectionColor ? window.nodigraphConnectionColor(c) : '?';
        return name(c.sourceBlockId) + '>' + name(c.targetBlockId) + ':' + color;
      }) : null,
      errs: window.__errs,
    });
  }, 400);
</script></body>`;

// What the board's /files upload wrote as project.json: served back by
// /api/project, as the firmware does.
let storedProject = null;
http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  log.push(`${req.method} ${p}`);
  if (p === '/__log') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(log)); }
  if (p === '/api/version') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ name: 'esp32-s3', node: 'a1d148c4', type: 'logic', version: '1.2', build: '20260927e', uptimeMs: 1 })); }
  if (p === '/files' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const name = (body.match(/filename="([^"]+)"/) || [])[1];
      const start = body.indexOf('\r\n\r\n') + 4;
      const end = body.lastIndexOf('\r\n--');
      const content = body.slice(start, end);
      log[log.length - 1] += ` (${name}, ${content.length} bytes)`;
      if (name === 'project.json') storedProject = content;
      res.end('OK');
    });
    return;
  }
  if (p === '/save-design' && req.method === 'POST') { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { log[log.length - 1] += ` (${Buffer.concat(chunks).length} bytes)`; res.end('OK'); }); return; }
  if (p === '/api/project') { res.setHeader('content-type', 'application/json'); return res.end(storedProject || 'null'); }
  // The circuit the board holds (as read off a real S3): DI1 (gpio 4)
  // into a Match that feeds the CAN block, and a Timer into DO1 (exio 1)
  // — so the load creates blocks, not only a pin-to-pin wire.
  if (p === '/design.json') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ blocks: [
      { id: 1, type: 'din', gx: 0, gy: 0, data: { gpio: 4, emitOnChange: true } },
      { id: 2, type: 'belt', gx: 2, gy: 0, data: { dir: 'E' } },
      { id: 3, type: 'croute', gx: 3, gy: 0, w: 2, h: 2, data: { routes: ['1', '0'] } },
      { id: 4, type: 'belt', gx: 5, gy: 0, data: { dir: 'E' } },
      { id: 5, type: 'belt', gx: 6, gy: 0, data: { dir: 'E' } },
      { id: 6, type: 'belt', gx: 7, gy: 0, data: { dir: 'E' } },
      { id: 7, type: 'belt', gx: 8, gy: 0, data: { dir: 'E' } },
      { id: 8, type: 'can', gx: 9, gy: 0, data: { tx: 2, rx: 3, bitrate: 250000, format: 'string' }, w: 2, h: 2 },
      { id: 9, type: 'timer', gx: 0, gy: 3, data: { onTime: 500, offTime: 500, mode: 'periodic' } },
      { id: 10, type: 'dout', gx: 3, gy: 3, data: { exio: 1 } },
      { id: 11, type: 'belt', gx: 2, gy: 3, data: { dir: 'E' } },
    ], nextId: 12 }));
  }
  if (p === '/api/modules') p = '/api/modules.json';
  else if (p.startsWith('/api/modules/')) p += '.json';
  else if (p.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); return res.end('null'); }
  if (p === '/') p = '/index.html';
  const file = path.join(site, p + '.gz');
  if (!fs.existsSync(file)) { res.statusCode = 302; res.setHeader('Location', '/'); return res.end(); }
  res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream');
  if (p === '/index.html') return res.end(zlib.gunzipSync(fs.readFileSync(file)).toString().replace('</body>', DIAG));
  res.setHeader('content-encoding', 'gzip');
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('harness on', port));
