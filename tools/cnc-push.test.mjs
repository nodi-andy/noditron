import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { consoleTextFor } from '../client/src/wifiTransport.js';
import { parseStatusReport } from '../client/src/cncPanel.js';

// A CNC across the bus pushes its status reports to the board a panel
// watches it through (firmware 20261018m on): `<from>@push><report>` on
// that board's console, a {"type":"push"} message on its WebSocket. The
// panel draws them and polls only as a heartbeat.

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const { PUSH_RE } = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { PUSH_RE };')();

test('a pushed report names its CNC and carries grbl\'s report', () => {
  const m = '85568abc@push><Run|MPos:42.000,0.000|FS:1000,0>'.match(PUSH_RE);
  assert.equal(m[1], '85568abc');
  assert.equal(parseStatusReport(m[2]).state, 'Run');
  assert.deepEqual(parseStatusReport(m[2]).mpos, [42, 0]);
  assert.equal('cnc-x@push><Idle|MPos:0.000,0.000|FS:0,0>'.match(PUSH_RE)[1], 'cnc-x');
});

test('only push lines are pushes: a relayed line or an answer is not', () => {
  assert.equal(PUSH_RE.test('a1d148c4@can>cnc ?'), false);
  assert.equal(PUSH_RE.test('<Idle|MPos:0.000,0.000|FS:0,0>'), false);
  assert.equal(PUSH_RE.test('cnc><Idle|MPos:0.000,0.000|FS:0,0>'), false);
});

test('the board\'s push message is that console line over WiFi', () => {
  assert.equal(consoleTextFor({ type: 'push', from: '85568abc', value: '<Jog|MPos:1.000,0.000|FS:500,0>' }), '85568abc@push><Jog|MPos:1.000,0.000|FS:500,0>');
  assert.equal(consoleTextFor({ type: 'push', value: '<Idle>' }), null);
});
