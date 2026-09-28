import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { buildSite, siteFiles, siteIndex, MAX_NAME } from './build-board-site.mjs';

// noditron as the Logic Module's own page: index.html, app.js and app.css
// (the whole editor bundled), the icon, and the module list as JSON the
// firmware's static handler serves — every file gzipped under /site/.

const PAGE = ['index.html', 'app.js', 'app.css', 'nodigraph/icon.svg', 'api/modules.json', 'api/modules/esp32-cnc.json', 'api/modules/esp32-s3-devkit.json'];

test('the site is the bundled page plus the modules as JSON', async () => {
  const files = await siteFiles();
  const names = files.map((f) => f.site);
  for (const must of PAGE) assert.ok(names.includes(must), must);
  assert.ok(!names.some((n) => n.endsWith('.js') && n !== 'app.js'), `one script only: ${names.filter((n) => n.endsWith('.js'))}`);
  assert.ok(!names.some((n) => n.endsWith('.css') && n !== 'app.css'), 'one stylesheet only');
  assert.ok(names.length < 12, `a handful of files, not ${names.length}`);
  const list = JSON.parse(files.find((f) => f.site === 'api/modules.json').bytes.toString());
  assert.deepEqual(Object.keys(list[0]).sort(), ['manifest', 'owner', 'path', 'ref', 'repo']);
  assert.ok(list.every((m) => m.owner === 'local' && m.repo === 'bundled' && m.manifest.noditronModule === 1));
});

test('app.js carries all three module graphs in document order, with no import left to fetch', async () => {
  const files = await siteFiles();
  const js = files.find((f) => f.site === 'app.js').bytes.toString();
  const extraTabs = js.indexOf('nodigraphHiddenProps');           // registerExtraTabs.js
  const nodigraph = js.indexOf('window.nodigraph=');               // the end of nodigraph's main.js
  const noditron = js.indexOf('outputsChanged');                   // noditron's main.js
  assert.ok(extraTabs >= 0 && nodigraph >= 0 && noditron >= 0, 'all three entries are in the bundle');
  assert.ok(extraTabs < nodigraph && nodigraph < noditron, 'registerExtraTabs, then nodigraph, then noditron');
  assert.ok(!/\bimport\s*\(\s*['"`]/.test(js), 'dynamic imports are inlined');
  assert.ok(!/^import\s/m.test(js) && !/\bfrom\s+['"][./]/.test(js), 'no static imports remain');
  assert.match(js, /serializeBlockDescription/, 'nodigraph modules noditron imports by absolute URL are resolved');
  assert.match(js, /window\.noditronModules\s*=/, 'block code strings take serialConsole and BlockDescription from the page, not by URL');
  for (const f of files.filter((x) => x.site.startsWith('api/modules/'))) {
    assert.ok(!/import\s*\(/.test(f.bytes.toString()), `${f.site}: a code string imports by URL, which the board cannot serve`);
  }
  const css = files.find((f) => f.site === 'app.css').bytes.toString();
  assert.ok(!/@import/.test(css), 'the stylesheets are concatenated, not linked');
  assert.match(css, /scene-canvas|topbar-hud/, "nodigraph's own stylesheet is in");
});

test('building writes gzipped files whose path segments fit LittleFS names', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'noditron-site-'));
  try {
    const result = await buildSite(out);
    assert.ok(result.files.length >= PAGE.length);
    assert.ok(result.packed < result.raw);
    assert.ok(result.packed < 400 * 1024, `the whole site under 400 KB gzipped, not ${result.packed}`);
    for (const f of result.files) {
      assert.ok(f.fsPath.startsWith('/site/') && f.fsPath.endsWith('.gz'));
      for (const part of f.fsPath.split('/')) assert.ok(part.length <= MAX_NAME, f.fsPath);
    }
    const index = zlib.gunzipSync(fs.readFileSync(path.join(result.siteDir, 'index.html.gz'))).toString();
    assert.match(index, /<title>noditron<\/title>/);
    assert.match(index, /<script type="module" src="app\.js"><\/script>/);
    assert.match(index, /<link rel="stylesheet" href="app\.css" \/>/);
    assert.ok(!/src="src\/|src="\/nodigraph\/src\/|href="styles\.css"|href="\/nodigraph\/styles\.css"/.test(index), 'no module or stylesheet is linked on its own');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the embedded build has no web fonts, icons or flasher, sets the host flag and adds its own stylesheet', async () => {
  const files = await siteFiles();
  const names = new Set(files.map((f) => f.site));
  assert.ok(!names.has('nodigraph/manifest.webmanifest') && ![...names].some((n) => n.startsWith('nodigraph/icons/')), 'no installable-app files');
  assert.ok(!names.has('nodigraph/vendor/peerjs.min.js'), 'no live-sync library');
  const js = files.find((f) => f.site === 'app.js').bytes.toString();
  assert.ok(!/ESP32ROM|class ESPLoader/.test(js), 'the flasher stub, not the 229 KB esptool-js bundle');
  const css = files.find((f) => f.site === 'app.css').bytes.toString();
  // embedded.css alone sets the system font stack (the minifier drops the
  // quotes around "Segoe UI").
  const SYSTEM_FONT = /system-ui,\s*-apple-system/;
  assert.match(css, SYSTEM_FONT, 'embedded.css is in app.css');
  const index = files.find((f) => f.site === 'index.html').bytes.toString();
  assert.ok(!/fonts\.g(oogleapis|static)\.com/.test(index), 'no Google Fonts');
  assert.match(index, /window\.nodigraphEmbedded = true/);
  assert.ok(index.indexOf('window.nodigraphEmbedded = true') < index.indexOf('<script type="module" src="app.js">'), 'the flag is set before the bundle runs');
  const full = await siteFiles({ full: true });
  const fullJs = full.find((f) => f.site === 'app.js').bytes.toString();
  assert.match(fullJs, /ESP32ROM|class ESPLoader/, '--full keeps the real flasher');
  assert.ok(full.some((f) => f.site === 'nodigraph/vendor/peerjs.min.js'), '--full keeps peerjs for live sessions');
  const fullIndex = full.find((f) => f.site === 'index.html').bytes.toString();
  assert.ok(!/nodigraphEmbedded/.test(fullIndex), '--full is not the embedded page');
  assert.ok(!SYSTEM_FONT.test(full.find((f) => f.site === 'app.css').bytes.toString()), '--full leaves embedded.css out');
});

test('siteIndex refuses an index.html it no longer recognises', () => {
  assert.throws(() => siteIndex('<html></html>'), /changed shape/);
});
