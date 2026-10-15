import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusReport, readStatusReply, jogLine } from '../client/src/cncPanel.js';

test('a grbl status report reads as state, positions and feed', () => {
  const report = parseStatusReport('<Idle|MPos:1.500,-2.000|FS:0,0|WCO:0.500,0.000>');
  assert.equal(report.state, 'Idle');
  assert.deepEqual(report.mpos, [1.5, -2]);
  assert.deepEqual(report.wco, [0.5, 0]);
  assert.equal(report.wpos, null);
  assert.equal(report.feed, 0);
  assert.equal(parseStatusReport('<Hold:0|WPos:0.000,0.000,1.000|F:300|Pn:XY>').pins, 'XY');
  assert.equal(parseStatusReport('ok'), null);
});

test('the reply to cnc ? is a report, no CNC, or silence', () => {
  assert.equal(readStatusReply({ ok: true, lines: ['<Idle|MPos:0.000,0.000|FS:0,0>'] }).kind, 'report');
  assert.equal(readStatusReply({ ok: false, error: 'unknown command "cnc" (type help or ls; cnc <line> for the CNC)', lines: [] }).kind, 'absent');
  assert.equal(readStatusReply({ ok: false, error: 'no reply', lines: [] }).kind, 'silent');
});

test('jog buttons send the pulsed jog when held, a grbl jog move per step', () => {
  assert.equal(jogLine('x', 1), 'cnc x jog start plus');
  assert.equal(jogLine('y', -1, { feed: '500' }), 'cnc y jog start minus 500');
  assert.equal(jogLine('x', -1, { step: '0.1' }), 'cnc $J=G91 G21 X-0.1 F1000');
  assert.equal(jogLine('y', 1, { step: '10', feed: '3000' }), 'cnc $J=G91 G21 Y10 F3000');
});
