import test from 'node:test';
import assert from 'node:assert/strict';
import { programLines, macroText, macroToProgram, lineOutcome, MACRO_MAX, terminalLine, historyStep, feedIgnoredHint } from '../client/src/cncControl.js';
import { pushProjectToBoard } from '../client/src/boardProjectSync.js';

test('a program streams without comments or blank lines, each line knowing where it came from', () => {
  const lines = programLines('%\n(setup)\nG21 G90 ; mm, absolute\n\nG0 X10 (rapid)\n  G1 Y5 F800  \n%');
  assert.deepEqual(lines, [
    { line: 'G21 G90', index: 2 },
    { line: 'G0 X10', index: 4 },
    { line: 'G1 Y5 F800', index: 5 },
  ]);
});

test('a macro is the program on one line, and back', () => {
  assert.equal(macroText('G91\nG0 X5 ; nudge\nG90'), 'G91; G0 X5; G90');
  assert.equal(macroText(Array.from({ length: 40 }, () => 'G0 X100.000').join('\n')), null, `past ${MACRO_MAX} characters it does not fit`);
  assert.equal(macroToProgram('G91; G0 X5;G90'), 'G91\nG0 X5\nG90');
});

test('a streamed line goes on when grbl took it, is retried when its input is full, stops the run on an error', () => {
  assert.equal(lineOutcome({ ok: true }), 'next');
  assert.equal(lineOutcome({ ok: false, error: 'cnc: no answer from grbl in 3 s' }), 'next');
  assert.equal(lineOutcome({ ok: false, error: "cnc: grbl's input is full" }), 'retry');
  assert.equal(lineOutcome({ ok: false, error: 'Unsupported command' }), 'error');
  assert.equal(lineOutcome(null), 'error');
});

function fakeBoards(nodesByAddress) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push([url, opts.method || 'GET']);
    const address = new URL(url).host;
    if (!(address in nodesByAddress)) throw new Error('unreachable');
    if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ node: nodesByAddress[address] }) };
    return { ok: true };
  };
  return { calls, fetchImpl };
}

test('the project goes only to the address that answers as the same board', async () => {
  // This computer is on another board's access point: 192.168.0.1 is not it.
  const { calls, fetchImpl } = fakeBoards({ '192.168.0.1': 'a1d148c4', '192.168.1.40': '85568abc' });
  const outcome = await pushProjectToBoard({ nodeId: '85568abc', addresses: ['192.168.0.1', '192.168.1.40'], data: { rootBlock: {} }, fetchImpl });
  assert.equal(outcome, 'sent');
  assert.deepEqual(calls.filter(([, method]) => method === 'POST'), [['http://192.168.1.40/files', 'POST']]);
});

test('no board answering as the node: nothing is written', async () => {
  const { calls, fetchImpl } = fakeBoards({ '192.168.0.1': 'a1d148c4' });
  assert.equal(await pushProjectToBoard({ nodeId: '85568abc', addresses: ['192.168.0.1', '-'], data: {}, fetchImpl }), 'unreachable');
  assert.equal(await pushProjectToBoard({ nodeId: '85568abc', addresses: ['-', '0.0.0.0'], data: {}, fetchImpl }), 'no-address');
  assert.equal(calls.filter(([, method]) => method === 'POST').length, 0);
});

test('the terminal sends to grbl, and an @ line to the board itself', () => {
  assert.equal(terminalLine('G0 X10'), 'cnc G0 X10');
  assert.equal(terminalLine('  $$ '), 'cnc $$');
  assert.equal(terminalLine('@log'), 'log');
  assert.equal(terminalLine('@ limit forget'), 'limit forget');
  assert.equal(terminalLine('@'), null);
  assert.equal(terminalLine('   '), null);
});

test('up and down walk what was typed, down past the newest is an empty line', () => {
  const typed = ['G0 X1', '$$', 'help'];
  let at = typed.length;
  let step = historyStep(typed, at, 'ArrowUp');
  assert.deepEqual(step, { at: 2, text: 'help' });
  step = historyStep(typed, step.at, 'ArrowUp');
  step = historyStep(typed, step.at, 'ArrowUp');
  assert.deepEqual(step, { at: 0, text: 'G0 X1' });
  assert.deepEqual(historyStep(typed, 0, 'ArrowUp'), { at: 0, text: 'G0 X1' }, 'stays on the oldest');
  assert.deepEqual(historyStep(typed, 2, 'ArrowDown'), { at: 3, text: '' });
  assert.deepEqual(historyStep([], 0, 'ArrowUp'), { at: 0, text: null }, 'nothing typed yet');
});

test('a move with F but no G0/G1 is warned about: after a reset it runs at rapid', () => {
  for (const line of ['x10 f100', 'X100 F1000', 'g90 x50 f100', 'G91 X-5 F200']) assert.ok(feedIgnoredHint(line), line);
  for (const line of ['g1 x50 f100', 'G01 X5 F100', 'G0 X10', 'x10', '$J=G91 X10 F100', 'G20 X1', 'f100']) assert.equal(feedIgnoredHint(line), null, line);
});
