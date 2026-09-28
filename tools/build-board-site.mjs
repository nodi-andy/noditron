#!/usr/bin/env node
// Builds noditron as a static site a Logic Module serves from its own
// flash, in place of the old belts editor — the S3's 10 MB LittleFS holds
// it easily; the classic DevKit's 128 KB filesystem cannot.
//
//   node tools/build-board-site.mjs [--full] [--out <dir>] [--upload <host> [--filter <text>]]
//
// What the noditron server does for the page is small (see server/src/
// app.js): serve nodigraph's client under /nodigraph/, noditron's own
// client at /, list and hand out the bundled modules, keep the project.
// Here the page is three files — index.html, app.js, app.css — plus the
// icon and the module list as plain JSON: the firmware's static handler
// answers /api/modules and /api/modules/<name> from them, and keeps the
// project in /project.json (see esp32_logic main.cpp, "noditron site").
// Every file is gzipped once into <out>/site/ (default: conucon's
// modules/esp32_logic/data/site, what `pio run -t buildfs` packs).
//
// Why one script and one stylesheet: the firmware's WebServer answers one
// request at a time, and over the board's own access point a request
// costs a round trip whatever its size. Served as modules the editor was
// 98 script requests queueing on that one connection; bundled it is one.
// esbuild does the bundling — nodigraph's client imported by its own
// relative paths, noditron's by the absolute /nodigraph/... and /src/...
// URLs the server would have answered (resolved here by a plugin), the
// three `<script type="module">` tags of index.html folded into one entry
// in document order, so window.nodigraphExtraTabs is still set before
// nodigraph's main.js reads it. The dynamic `import()`s land in the same
// file. peerjs stays a separate script: nodigraph injects it as a plain
// script tag only when a live session starts, and only in --full.
//
// The build is the embedded one unless --full: nodigraph's editor as it
// is, but a plain flow layout (client/embedded.css) in place of floating
// chips, the system font in place of web fonts, no installable-app or
// live-sync plumbing (window.nodigraphEmbedded, a nodigraph host flag),
// no flasher bundle (a page over plain HTTP has no Web Serial; a stub
// stands in), and only the blocks the firmware runs in the Add Block
// window. --full keeps everything, fonts, icons and flasher included.
// With --upload the files go to a running board over its /files upload,
// one by one, leaving everything else on its flash alone (its saved WiFi
// network above all — an FS image would wipe it).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const NODITRON_CLIENT = path.join(here, '..', 'client');
const NODIGRAPH_CLIENT = process.env.NODIGRAPH_CLIENT_DIR || path.join(here, '..', '..', 'nodigraph', 'client');
const MODULES_DIR = path.join(here, '..', 'modules');
// LittleFS on the ESP32 caps a name at 64 bytes (CONFIG_LITTLEFS_OBJ_NAME_LEN).
export const MAX_NAME = 63;

const ESPTOOL_STUB = 'vendor/esptool-js/esptool-js.embedded-stub.js';

// noditron's index.html, as the board serves it: the three stylesheets as
// app.css, the three module scripts as app.js (in their place, so the DOM
// above them is there when they run). The embedded page also drops the
// web fonts (they block rendering for seconds on a board's own access
// point) and sets the host flag before the bundle runs.
export function siteIndex(html, { full = false } = {}) {
  const replace = (out, needle, by) => {
    if (!out.includes(needle)) throw new Error(`index.html changed shape; siteIndex needs updating (${needle.trim()})`);
    return out.replace(needle, by);
  };
  let out = html;
  if (!full) out = out.replace(/\s*<link[^>]*fonts\.g(?:oogleapis|static)\.com[^>]*>/gs, '');
  out = replace(out, '<link rel="stylesheet" href="/nodigraph/styles.css" />', '<link rel="stylesheet" href="app.css" />');
  out = replace(out, '\n  <link rel="stylesheet" href="styles.css" />', '');
  out = replace(out, '<script type="module" src="src/registerExtraTabs.js"></script>',
    `${full ? '' : '<script>window.nodigraphEmbedded = true;</script>\n  '}<script type="module" src="app.js"></script>`);
  out = replace(out, '\n  <script type="module" src="/nodigraph/src/main.js"></script>', '');
  out = replace(out, '\n  <script type="module" src="src/main.js"></script>', '');
  return out;
}

export function collectFiles(root, skip = new Set(), rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip.has(relPath) || skip.has(entry.name) && !rel) continue;
    if (entry.isDirectory()) out.push(...collectFiles(root, skip, relPath));
    else out.push(relPath);
  }
  return out;
}

export function moduleEntries(modulesDir = MODULES_DIR) {
  const entries = [];
  for (const dir of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(modulesDir, dir.name, 'noditron.module.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.noditronModule !== 1) continue;
    entries.push({ name: dir.name, owner: 'local', repo: 'bundled', ref: 'local', path: `modules/${dir.name}/noditron.module.json`, manifest });
  }
  return entries;
}

// The URLs the page's own imports use, resolved to the two checkouts the
// way server/src/app.js serves them; the flasher swapped for its stub in
// the embedded build.
function siteResolver({ noditronClient, nodigraphClient, full }) {
  const under = (root, rel) => ({ path: path.join(root, ...rel.split('/')) });
  return {
    name: 'noditron-site-paths',
    setup(build) {
      build.onResolve({ filter: /^\/nodigraph\// }, (args) => under(nodigraphClient, args.path.slice('/nodigraph/'.length)));
      build.onResolve({ filter: /^\/src\// }, (args) => under(noditronClient, args.path.slice(1)));
      if (!full) build.onResolve({ filter: /esptool-js\.bundle\.js$/ }, () => under(noditronClient, ESPTOOL_STUB));
    },
  };
}

// index.html's three module scripts as one entry, in document order.
const JS_ENTRY = "import './src/registerExtraTabs.js';\nimport '/nodigraph/src/main.js';\nimport './src/main.js';\n";
const cssEntry = (full) => `@import "/nodigraph/styles.css";\n@import "./styles.css";\n${full ? '' : '@import "./embedded.css";\n'}`;

export async function bundlePage({ noditronClient = NODITRON_CLIENT, nodigraphClient = NODIGRAPH_CLIENT, full = false } = {}) {
  const common = {
    bundle: true,
    write: false,
    charset: 'utf8',
    target: 'es2022',
    legalComments: 'inline',
    // Whitespace and syntax only: names stay as written, so a stack trace
    // from a board still reads like the source.
    minifyWhitespace: true,
    minifySyntax: true,
    plugins: [siteResolver({ noditronClient, nodigraphClient, full })],
    logLevel: 'silent',
  };
  const js = await esbuild.build({ ...common, format: 'esm', stdin: { contents: JS_ENTRY, resolveDir: noditronClient, sourcefile: 'app.js', loader: 'js' } });
  const css = await esbuild.build({ ...common, stdin: { contents: cssEntry(full), resolveDir: noditronClient, sourcefile: 'app.css', loader: 'css' } });
  const one = (result, name) => {
    if (result.outputFiles.length !== 1) throw new Error(`${name}: esbuild produced ${result.outputFiles.length} files, expected one`);
    return Buffer.from(result.outputFiles[0].contents);
  };
  return { js: one(js, 'app.js'), css: one(css, 'app.css') };
}

// Every file of the site as { site: 'app.js', bytes }.
export async function siteFiles({ noditronClient = NODITRON_CLIENT, nodigraphClient = NODIGRAPH_CLIENT, modulesDir = MODULES_DIR, full = false } = {}) {
  const files = [];
  const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')));
  files.push({ site: 'index.html', bytes: Buffer.from(siteIndex(read(noditronClient, 'index.html').toString('utf8'), { full })) });
  const { js, css } = await bundlePage({ noditronClient, nodigraphClient, full });
  files.push({ site: 'app.js', bytes: js });
  files.push({ site: 'app.css', bytes: css });
  files.push({ site: 'nodigraph/icon.svg', bytes: read(nodigraphClient, 'icon.svg') });
  if (full) {
    // The installable-app files, the lazily loaded peerjs, and the licences
    // of what app.js now carries inline.
    for (const rel of ['manifest.webmanifest', 'vendor/peerjs.min.js', 'vendor/peerjs-LICENSE']) files.push({ site: `nodigraph/${rel}`, bytes: read(nodigraphClient, rel) });
    for (const rel of collectFiles(path.join(nodigraphClient, 'icons'))) files.push({ site: `nodigraph/icons/${rel}`, bytes: read(nodigraphClient, `icons/${rel}`) });
    files.push({ site: 'vendor/esptool-js/LICENSE', bytes: read(noditronClient, 'vendor/esptool-js/LICENSE') });
  }
  const modules = moduleEntries(modulesDir);
  files.push({ site: 'api/modules.json', bytes: Buffer.from(JSON.stringify(modules.map(({ name, ...rest }) => rest))) });
  for (const entry of modules) files.push({ site: `api/modules/${entry.name}.json`, bytes: Buffer.from(JSON.stringify(entry.manifest)) });
  return files;
}

export async function buildSite(outDir, options = {}) {
  const siteDir = path.join(outDir, 'site');
  fs.rmSync(siteDir, { recursive: true, force: true });
  const written = [];
  let raw = 0;
  let packed = 0;
  for (const { site, bytes } of await siteFiles(options)) {
    const fsPath = `/site/${site}.gz`;
    const longest = fsPath.split('/').reduce((m, part) => Math.max(m, part.length), 0);
    if (longest > MAX_NAME) throw new Error(`${fsPath}: a path segment is longer than ${MAX_NAME} bytes, which LittleFS refuses`);
    const gz = zlib.gzipSync(bytes, { level: 9 });
    const target = path.join(siteDir, `${site}.gz`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, gz);
    written.push({ site, fsPath, raw: bytes.length, packed: gz.length });
    raw += bytes.length;
    packed += gz.length;
  }
  return { siteDir, files: written, raw, packed };
}

async function upload(host, siteDir, files) {
  const base = `http://${host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
  let n = 0;
  for (const { fsPath } of files) {
    const body = new FormData();
    body.append('file', new Blob([fs.readFileSync(path.join(siteDir, '..', fsPath))]), fsPath.slice(1));
    const res = await fetch(`${base}/files`, { method: 'POST', body });
    if (!res.ok) throw new Error(`${fsPath}: the board answered ${res.status}`);
    n += 1;
    process.stdout.write(`\r${n}/${files.length} ${fsPath}`.padEnd(80));
  }
  process.stdout.write('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const outDir = opt('--out') || path.join(here, '..', '..', 'conucon', 'modules', 'esp32_logic', 'data');
  const { siteDir, files, raw, packed } = await buildSite(outDir, { full: args.includes('--full') });
  console.log(`site (${args.includes('--full') ? 'full' : 'embedded'}): ${files.length} files, ${(raw / 1024).toFixed(0)} KB -> ${(packed / 1024).toFixed(0)} KB gzipped, in ${siteDir}`);
  for (const f of files) console.log(`  ${f.site.padEnd(36)} ${String(f.packed).padStart(7)} B gzipped`);
  // --filter <text>: upload only the files whose path contains it (a
  // resumed or partial upload; the whole site is a handful of files now).
  const only = opt('--filter');
  const host = opt('--upload');
  if (host) await upload(host, siteDir, only ? files.filter((f) => f.fsPath.includes(only)) : files);
}
