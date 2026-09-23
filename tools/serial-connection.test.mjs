import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../client/src/serialConsole.js', import.meta.url), 'utf8');
function consoleFor(session) {
  return new Function('getSession', 'ensureOpenPlain', source
    .replace(/^import .*;$/gm, '')
    .replace(/export /g, '') + '\nreturn { identify, openConsole, closeConsole, setLogIncoming, subscribeIoChanges };')(
      () => session, async () => session,
    );
}

test('identify recovers from a read error without reopening the port', async () => {
  const encoder = new TextEncoder();
  let controller;
  let readable = new ReadableStream({ start(c) { controller = c; } });
  const device = {
    get readable() { return readable; },
    writable: new WritableStream({ write() {} }),
  };
  const api = consoleFor({ transport: { device } });
  api.setLogIncoming(false);
  const identified = api.identify('board', { timeoutMs: 500, pingEveryMs: 10 });
  setTimeout(() => {
    controller.enqueue(encoder.encode('ESP-ROM:esp32s3-20210327\n'));
    const old = controller;
    readable = new ReadableStream({ start(c) { controller = c; } });
    old.error(new Error('framing error'));
    controller.enqueue(encoder.encode('[INFO] LogicMod v1.2 build test | AP=logic | IP=1.2.3.4 | heap=1000 | circuit=active nCB=2\n'));
  }, 10);
  assert.equal((await identified).verified, true);
  const state = api.openConsole('board');
  api.closeConsole('board');
  await state.reading;
  assert.equal(readable.locked, false);
});

test('unsolicited input-change messages reach the Web UI without a poll command', async () => {
  const encoder = new TextEncoder();
  let controller;
  const readable = new ReadableStream({ start(c) { controller = c; } });
  const session = { transport: { device: { readable } } };
  const api = consoleFor(session);
  api.setLogIncoming(false);
  const received = new Promise(resolve => api.subscribeIoChanges('board', resolve));
  const state = api.openConsole('board');
  controller.enqueue(encoder.encode('{"type":"io-change","pins":[{"gpio":4,"output":false,"state":true}]}\n'));
  assert.deepEqual(await received, [{ gpio: 4, output: false, state: true }]);
  assert.equal(state.queue.length, 0, 'event is not left behind to corrupt a command reply');
  api.closeConsole('board');
  await state.reading;
});

test('closing an old console does not cancel a replacement transport reader', async () => {
  const device = { readable: new ReadableStream() };
  const session = { transport: { device } };
  const api = consoleFor(session);
  const state = api.openConsole('board');
  let cancelled = false;
  session.transport = { reader: { cancel() { cancelled = true; return Promise.resolve(); } } };
  api.closeConsole('board');
  await state.reading;
  assert.equal(cancelled, false);
  assert.equal(device.readable.locked, false);
});

test('flash refuses classic ESP32 preset parts on a detected S3 before writing', async () => {
  const flashSource = fs.readFileSync(new URL('../client/src/serialFlash.js', import.meta.url), 'utf8');
  const api = new Function(flashSource.replace(/^import .*;$/gm, '').replace(/export /g, '') + '\nreturn { flash, sessions };')();
  let writes = 0;
  api.sessions.set('board', { chipName: 'ESP32-S3 (QFN56) (revision v0.2)', esploader: { writeFlash() { writes++; } } });
  await assert.rejects(api.flash('board', [{ chip: 'ESP32', bytes: new Uint8Array(0) }]), /cannot be installed/);
  assert.equal(writes, 0);
});

test('native ESP32-S3 USB uses ROM flashing instead of the unstable RAM stub', () => {
  const flashSource = fs.readFileSync(new URL('../client/src/serialFlash.js', import.meta.url), 'utf8');
  assert.match(flashSource.replace(/\s+/g, ' '), /usbProductId === ESPRESSIF_USB_JTAG_SERIAL_PID/);
  assert.match(flashSource, /await esploader\.detectChip\(\)/);
  assert.match(flashSource, /Using ROM flasher for native USB/);
});

for (const name of ['esp32-devkit', 'esp32-s3-devkit']) {
  test(`${name} selects S3 firmware from detection even for a classic diagram block`, () => {
    const module = JSON.parse(fs.readFileSync(new URL(`../modules/${name}/noditron.module.json`, import.meta.url)));
    const source = Object.values(module.block.blocks)[0].props.find(p => p.name === 'dialog').value;
    new Function('container', 'block', 'props', 'outputs', 'helpers', source);
    const start = source.indexOf('      const family = detected.chipName');
    const end = source.indexOf('      installBtn.disabled = !matchingPreset;', start) + '      installBtn.disabled = !matchingPreset;'.length;
    assert.ok(start > 0);
    const presets = [{ id: 'classic', chip: 'ESP32' }, { id: 's3', chip: 'ESP32-S3' }];
    const select = { options: presets.map(p => ({ value: p.id })), value: 'classic' };
    const button = {};
    new Function('detected', 'presets', 'firmwareSelect', 'installBtn', 'props', source.slice(start, end))(
      { chipName: 'ESP32-S3 (QFN56) (revision v0.2)' }, presets, select, button, {},
    );
    assert.equal(select.value, 's3');
    assert.equal(select.options[0].disabled, true);
    assert.equal(button.disabled, false);
  });
}
