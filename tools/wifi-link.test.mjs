import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { consoleTextFor, takeLines } from '../client/src/wifiTransport.js';

// A board over WiFi is the same console: the board's WebSocket messages
// become the lines the serial link would have carried, and what the
// console writes becomes shell messages, one per line.

test('board messages become the console lines the serial link would carry', () => {
  assert.equal(consoleTextFor({ type: 'shell', line: 'nodes', output: 'logic a1d148c4 esp32-s3 v1.2 self\nok\n' }), 'logic a1d148c4 esp32-s3 v1.2 self\nok\n');
  assert.equal(consoleTextFor({ type: 'io', pins: [{ gpio: 4, output: false, state: true }] }), '{"type":"io-change","pins":[{"gpio":4,"output":false,"state":true}]}');
  assert.equal(consoleTextFor({ type: 'console', line: '[USB] hellooo' }), '[USB] hellooo');
  assert.equal(consoleTextFor({ type: 'can_in', value: 'ok' }), '[CAN] rx ok');
  assert.equal(consoleTextFor({ type: 'route_sel', id: 3 }), null);
  assert.equal(consoleTextFor('garbage'), null);
});

test('console writes are cut into whole shell lines, a partial tail kept for later', () => {
  let state = takeLines('', '?\npi');
  assert.deepEqual(state.lines, ['?']);
  state = takeLines(state.pending, 'ng\r\n\nwifi status\n');
  assert.deepEqual(state.lines, ['ping', 'wifi status']);
  assert.equal(state.pending, '');
});

// The console's design read and save go over HTTP for a WiFi session.
const source = fs.readFileSync(new URL('../client/src/serialConsole.js', import.meta.url), 'utf8');
function consoleOver(session) {
  return new Function('getSession', 'ensureOpenPlain', source
    .replace(/^import .*;$/gm, '')
    .replace(/export /g, '') + '\nreturn { readDesign, sendDesign };')(() => session, async () => session);
}

test('over WiFi a design is read from design.json and saved through /save-design', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.endsWith('/design.json')) return { ok: true, status: 200, text: async () => '{"blocks":[{"id":1,"type":"din","gx":0,"gy":0,"data":{"gpio":4}}]}' };
    if (url.endsWith('/save-design')) return { ok: true, status: 200, text: async () => 'OK' };
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const api = consoleOver({ kind: 'wifi', host: '192.168.1.174' });
    const design = await api.readDesign('board');
    assert.equal(design.blocks[0].data.gpio, 4);
    const result = await api.sendDesign('board', { blocks: [] });
    assert.match(result, /\[DESIGN] Saved \d+ bytes OK/);
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', 'http://192.168.1.174/design.json'], ['POST', 'http://192.168.1.174/save-design']]);
    assert.ok(calls[1].body instanceof FormData);
    assert.equal(calls[1].body.get('design').name, 'design.json');
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { rawFrameText } from '../client/src/wifiTransport.js';

test('a CNC module\'s raw websocket frames are console text, its housekeeping is not', () => {
  assert.equal(rawFrameText('[INFO] CncMod v1.4a build x | AP=- | IP=1.2.3.4 | heap=1 | state=Idle\r\nok\r\n'), '[INFO] CncMod v1.4a build x | AP=- | IP=1.2.3.4 | heap=1 | state=Idle\r\nok\r\n');
  assert.equal(rawFrameText('<Idle|MPos:0.000,0.000|FS:0,0>\r\n'), '<Idle|MPos:0.000,0.000|FS:0,0>\r\n');
  assert.equal(rawFrameText('CURRENT_ID:1'), null);
  assert.equal(rawFrameText('ACTIVE_ID:1'), null);
  assert.equal(rawFrameText('PING:1'), null);
  assert.equal(rawFrameText(''), null);
});
