import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(read('../modules/esp32-cnc/noditron.module.json'));
const block = manifest.block.blocks[0];
const prop = (name) => block.props.find((p) => p.name === name)?.value;

test('the CNC module is a leaf with one gcode input and the shared connection dialog', () => {
  assert.equal(manifest.name, 'esp32-cnc');
  assert.equal(prop('noditronKind'), 'cnc-module');
  assert.deepEqual(block.logicalPorts.map((p) => [p.name, p.direction]), [['gcode', 'in']]);
  assert.equal(block.hasChildren, false);
  const dialog = prop('dialog');
  for (const piece of ['Connect (COM)', 'Connect (WiFi)', 'MACHINE', 'CONNECTIVITY', 'SHELL', "createElement('iframe')", 'showMachinePage(info.ip)', "info.kind === 'cnc'"]) {
    assert.ok(dialog.includes(piece), piece);
  }
  new Function('container', 'block', 'props', 'outputs', 'helpers', dialog);
  new Function('container', 'block', 'inputs', 'outputs', 'helpers', prop('html'));
  assert.match(prop('html'), /grbl running/);
});

// identify() tells a CNC module from a Logic Module by its info line.
const source = read('../client/src/serialConsole.js');
function consoleFor(session) {
  return new Function('getSession', 'ensureOpenPlain', source
    .replace(/^import .*;$/gm, '')
    .replace(/export /g, '') + '\nreturn { identify, closeConsole, setLogIncoming };')(() => session, async () => session);
}

test('a CNC module answers ping with its own info line and identify reports kind cnc', async () => {
  const encoder = new TextEncoder();
  let controller;
  const readable = new ReadableStream({ start(c) { controller = c; } });
  const device = {
    get readable() { return readable; },
    writable: new WritableStream({ write(chunk) {
      if (new TextDecoder().decode(chunk).includes('ping')) {
        setTimeout(() => controller.enqueue(encoder.encode('[INFO] CncMod v1.4a build 20260925a | AP=NDTCOM | IP=192.168.0.1 | heap=100000 | state=Alarm\n')), 5);
      }
    } }),
  };
  const api = consoleFor({ transport: { device } });
  api.setLogIncoming(false);
  const info = await api.identify('cnc', { timeoutMs: 500, pingEveryMs: 10 });
  assert.equal(info.verified, true);
  assert.equal(info.kind, 'cnc');
  assert.equal(info.version, '1.4a');
  assert.equal(info.machineState, 'Alarm');
  api.closeConsole('cnc');
});

test('identify waits out grbl\'s boot and WiFi join before giving up on a CNC module', async () => {
  const encoder = new TextEncoder();
  let controller;
  const readable = new ReadableStream({ start(c) { controller = c; } });
  let pings = 0;
  const device = {
    get readable() { return readable; },
    writable: new WritableStream({ write(chunk) {
      if (!new TextDecoder().decode(chunk).includes('ping')) return;
      pings += 1;
      // The board is still joining its network for the first pings, then answers.
      if (pings < 4) controller.enqueue(encoder.encode("Grbl 1.4a ['$' for help]\n[MSG:Connecting DHLAN]\n[MSG:Connecting.]\n"));
      else setTimeout(() => controller.enqueue(encoder.encode('[INFO] CncMod v1.4a build 20260925e | AP=- | IP=192.168.1.171 | heap=1 | state=Alarm\nok\n')), 5);
    } }),
  };
  const api = consoleFor({ transport: { device } });
  api.setLogIncoming(false);
  // A budget shorter than the join: without the grace it would time out.
  const info = await api.identify('cnc', { timeoutMs: 60, pingEveryMs: 30, bootGraceMs: 2000 });
  assert.equal(info.verified, true);
  assert.equal(info.kind, 'cnc');
  api.closeConsole('cnc');
});
