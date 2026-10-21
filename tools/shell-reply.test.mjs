import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// A shell command's answer ends at its own `ok <the command>`: an ok naming
// another command is the late answer to an earlier one that timed out, and
// taking it as this one's put every reply after it one command behind
// (`[TRACE] on` shown as the answer to `cnc x10`).

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const { okNames } = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { okNames };')();

test('a bare ok, or one naming the command, ends it', () => {
  assert.equal(okNames('cnc x jog start plus', ''), true);
  assert.equal(okNames('cnc x jog start plus', 'cnc x jog start plus'), true);
});

test('an ok naming another command is not this one\'s', () => {
  assert.equal(okNames('cnc x10', 'trace on'), false);
  assert.equal(okNames('cnc ?', 'pins'), false);
});

test('relayed, the far node names its own part of node <to> <line>', () => {
  assert.equal(okNames('node 85568abc cnc ?', 'cnc ?'), true);
  assert.equal(okNames('node a node b ls can', 'ls can'), true);
  assert.equal(okNames('node 85568abc cnc ?', 'ping'), false);
});

test('a long command comes back cut to 45 characters and ...', () => {
  const line = 'cnc macro write 1 G21 G90; G0 X0 Y0; G1 X20 F800; G0 X0';
  assert.equal(okNames(line, line.slice(0, 45) + '...'), true);
  assert.equal(okNames('node 85568abc ' + line, line.slice(0, 45) + '...'), true);
  assert.equal(okNames('cnc macro write 2 other', line.slice(0, 45) + '...'), false);
});

// A typed line or a jog goes ahead of the app's waiting polls, behind the
// command already running; polls keep their own order.
const { queueCommand } = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { queueCommand };')();
test('urgent commands go ahead of waiting quiet ones, never ahead of the running one', async () => {
  const order = [];
  const job = (name, ms) => () => new Promise((r) => setTimeout(() => { order.push(name); r(name); }, ms));
  const all = [
    queueCommand('b', job('poll1', 20), { quiet: true }),
    queueCommand('b', job('poll2', 5), { quiet: true }),
    queueCommand('b', job('poll3', 5), { quiet: true }),
    queueCommand('b', job('jog', 5), { quiet: true, urgent: true }),
    queueCommand('b', job('typed', 5)),
  ];
  await Promise.all(all);
  assert.deepEqual(order, ['poll1', 'jog', 'typed', 'poll2', 'poll3']);
});
