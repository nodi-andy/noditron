import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { noteNodes, forgetBridge, bridgeForNode, nodesBehind, resetRegistry, STALE_MS } from '../client/src/canBridgeRegistry.js';
import { parseNodesOutput } from '../client/src/moduleDiscovery.js';

// A board behind another board's CAN bus is online through it: its shell
// lines go as `node <name> <line>` on the bridge and the reply is its own.

test('who is behind whom: nodes heard via can, forgotten with their bridge or when stale', () => {
  resetRegistry();
  const nodes = parseNodesOutput(['logic a1d148c4 esp32-s3 v1.2 self', 'cnc 0dd04644 CNC v1.4 seen 0s ago via can', 'logic 1b2c3d4e other v1.2 seen 3s ago via wifi']);
  noteNodes('blk_s3', nodes, 1000);
  assert.equal(bridgeForNode('0dd04644', 1000), 'blk_s3');
  assert.equal(bridgeForNode('1b2c3d4e', 1000), null, 'a node heard over wifi is not behind the bridge');
  assert.equal(bridgeForNode('a1d148c4', 1000), null, 'the bridge itself is not behind itself');
  assert.deepEqual(nodesBehind('blk_s3', 1000), ['0dd04644']);
  assert.equal(bridgeForNode('0dd04644', 1000 + STALE_MS + 1), null, 'not heard for a while: gone');
  noteNodes('blk_s3', nodes, 5000);
  forgetBridge('blk_s3');
  assert.equal(bridgeForNode('0dd04644', 5000), null);
});

// serialConsole.js with a fake link for the bridge and none for the CNC:
// the bridge's transport answers `node cnc <line>` the way the S3 does —
// the far board's lines, then its ok.
const source = fs.readFileSync(new URL('../client/src/serialConsole.js', import.meta.url), 'utf8');
function consoleWith(sessions) {
  return new Function('getSession', 'ensureOpenPlain', source
    .replace(/^import .*;$/gm, '')
    .replace(/export /g, '')
    + '\nreturn { shell, identify, closeConsole, setLogIncoming, setBridgeResolver, bridgeFor, subscribeConsoleLines };')(
    (id) => sessions[id] || null,
    async (id) => sessions[id] || null,
  );
}

function fakeBoard(answer) {
  const encoder = new TextEncoder();
  let controller;
  const readable = new ReadableStream({ start(c) { controller = c; } });
  const written = [];
  const device = {
    get readable() { return readable; },
    writable: new WritableStream({ write(chunk) {
      const text = new TextDecoder().decode(chunk).replace(/\n$/, '');
      written.push(text);
      const reply = answer(text);
      if (reply) setTimeout(() => controller.enqueue(encoder.encode(reply)), 5);
    } }),
  };
  return { session: { transport: { device } }, written };
}

test('a bridged block\'s shell line goes to the bridge as node <name> <line> and the reply is the far board\'s', async () => {
  const bridge = fakeBoard((line) => (line === 'node cnc status' ? '<Alarm|MPos:0.000,0.000,0.000|FS:0,0>\nok\n' : 'error: unknown\n'));
  const api = consoleWith({ esp: bridge.session });
  api.setLogIncoming(false);
  api.setBridgeResolver((id) => (id === 'cnc' ? { bridgeId: 'esp', target: 'cnc' } : null));
  assert.deepEqual(api.bridgeFor('cnc'), { bridgeId: 'esp', target: 'cnc' });
  assert.equal(api.bridgeFor('esp'), null, 'the bridge has a link of its own');

  const seen = [];
  api.subscribeConsoleLines('cnc', (event) => seen.push([event.outgoing ? '>' : '<', event.line]));
  const reply = await api.shell('cnc', 'status', { timeoutMs: 500 });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.lines, ['<Alarm|MPos:0.000,0.000,0.000|FS:0,0>']);
  assert.deepEqual(bridge.written, ['node cnc status']);
  assert.deepEqual(seen, [['>', 'status'], ['<', '<Alarm|MPos:0.000,0.000,0.000|FS:0,0>'], ['<', 'ok']], 'the far block\'s own listeners see the exchange');
  api.closeConsole('esp');
});

test('identify through a bridge reads the far board\'s ping reply', async () => {
  const bridge = fakeBoard((line) => (line === 'node CNC ping'
    ? '[INFO] CncMod v1.4a build 20260927b | AP=- | IP=- | heap=180000 | state=Alarm\n[INFO] node=0dd04644 type=cnc name=CNC sta=DHLAN ip=- nodes=1\nok\n'
    : 'error: no reply from cnc\n'));
  const api = consoleWith({ esp: bridge.session });
  api.setLogIncoming(false);
  api.setBridgeResolver((id) => (id === 'cnc' ? { bridgeId: 'esp', target: 'CNC' } : null));
  const info = await api.identify('cnc');
  assert.equal(info.verified, true);
  assert.equal(info.kind, 'cnc');
  assert.equal(info.build, '20260927b');
  assert.equal(info.node, '0dd04644');
  assert.equal(info.nodeName, 'CNC');
  assert.equal(info.via, 'esp');
  assert.deepEqual(bridge.written, ['node CNC ping']);
  api.closeConsole('esp');
});

test('a far board that does not answer identifies as unverified, not as an error', async () => {
  const bridge = fakeBoard(() => 'error: no reply from cnc\n');
  const api = consoleWith({ esp: bridge.session });
  api.setLogIncoming(false);
  api.setBridgeResolver((id) => (id === 'cnc' ? { bridgeId: 'esp', target: 'cnc' } : null));
  const info = await api.identify('cnc');
  assert.equal(info.verified, false);
  api.closeConsole('esp');
});
