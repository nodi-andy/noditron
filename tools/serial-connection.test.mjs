import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../client/src/serialConsole.js', import.meta.url), 'utf8');
function consoleFor(session) {
  return new Function('getSession', 'ensureOpenPlain', 'isFlashing', source
    .replace(/^import .*;$/gm, '')
    .replace(/export /g, '') + '\nreturn { identify, openConsole, closeConsole, setLogIncoming, subscribeIoChanges, shell, subscribeConsoleLines };')(
      () => session, async () => session, () => false,
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

test('a design larger than the S3 USB receive queue is paced and must be acknowledged', async () => {
  const encoder = new TextEncoder();
  let controller;
  const readable = new ReadableStream({ start(c) { controller = c; } });
  const chunks = [];
  let expected = 0, received = 0;
  const writable = new WritableStream({
    write(bytes) {
      const text = new TextDecoder().decode(bytes);
      const announce = text.match(/^save-design (\d+)\n$/);
      if (announce) {
        expected = Number(announce[1]);
        controller.enqueue(encoder.encode('{"type":"io","pins":[]}\n[DESIGN] READY ' + expected + '\n'));
        return;
      }
      chunks.push(bytes.length);
      received += bytes.length;
      if (received === expected) controller.enqueue(encoder.encode(`[DESIGN] Saved ${received} bytes OK\n`));
    },
  });
  const api = new Function('getSession', 'ensureOpenPlain', 'isFlashing', source
    .replace(/^import .*;$/gm, '')
    .replace(/export /g, '') + '\nreturn { sendDesign, setLogIncoming, closeConsole };')(
      () => ({ transport: { device: { readable, writable } } }), async () => {}, () => false,
    );
  api.setLogIncoming(false);
  const design = { blocks: Array.from({ length: 12 }, (_, id) => ({ id, type: 'din', gx: 0, gy: id * 3, data: { gpio: 4 } })) };
  const result = await api.sendDesign('board', design);
  assert.ok(expected > 256, 'test design exceeds the 256-byte HWCDC queue');
  assert.match(result, /\[DESIGN] Saved \d+ bytes OK/);
  assert.ok(chunks.length > 1 && chunks.every(n => n <= 64));
  api.closeConsole('board');
});

test('a design the board never confirms is reported as a failure', async () => {
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const writable = new WritableStream({
    write(bytes) {
      if (/^save-design/.test(new TextDecoder().decode(bytes))) controller.enqueue(new TextEncoder().encode('[DESIGN] READY 10\n'));
    },
  });
  const api = new Function('getSession', 'ensureOpenPlain', 'isFlashing', source
    .replace(/^import .*;$/gm, '')
    .replace(/export /g, '') + '\nreturn { sendDesign, setLogIncoming, closeConsole };')(
      () => ({ transport: { device: { readable: stream, writable } } }), async () => {}, () => false,
    );
  api.setLogIncoming(false);
  await assert.rejects(api.sendDesign('board', { blocks: [] }, { timeoutMs: 100 }), /did not confirm/);
  api.closeConsole('board');
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

// An ESP32-S3 on its native USB re-enumerates when it is reset or when
// its firmware starts its own USB stack: the browser fires 'disconnect'
// and hands a new SerialPort back on 'connect'. The session keeps the
// board across that (see serialFlash.portLost / portReturned) instead of
// dropping it and failing whatever was mid-flight with "Not connected".
function flashApiForPorts(graceMs) {
  const flashSource = fs.readFileSync(new URL('../client/src/serialFlash.js', import.meta.url), 'utf8');
  assert.ok(flashSource.includes('const PORT_RETURN_GRACE_MS = 8000;'));
  const source = flashSource.replace('const PORT_RETURN_GRACE_MS = 8000;', `const PORT_RETURN_GRACE_MS = ${graceMs};`);
  const portIdentity = (port) => ({ usbVendorId: port.getInfo().usbVendorId ?? null, usbProductId: port.getInfo().usbProductId ?? null });
  const sameIdentity = (a, b) => Boolean(a && b) && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
  function Transport(port) { this.device = port; this.disconnect = async () => {}; }
  return new Function('Transport', 'portIdentity', 'sameIdentity', 'forgetPort', 'forgetWifi',
    source.replace(/^import .*;$/gm, '').replace(/export /g, '') + '\nreturn { portLost, portReturned, sessions, findSessionByPort };')(
    Transport, portIdentity, sameIdentity, () => {}, () => {},
  );
}
const s3Port = () => ({ getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) });

test('a port that comes back within the grace keeps its session, on the new handle', async () => {
  const api = flashApiForPorts(8000);
  const oldPort = s3Port();
  const newPort = s3Port();
  api.sessions.set('cnc', { port: oldPort, transport: { device: oldPort, disconnect: async () => {} }, esploader: {}, bootloaderDirty: true });
  assert.equal(api.portLost({ getInfo: () => ({}) }), null, 'a port nobody holds');
  const lost = api.portLost(oldPort);
  assert.equal(lost.blockId, 'cnc');
  assert.equal(api.portReturned({ getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) }), null, 'a different board');
  assert.equal(api.portReturned(newPort), 'cnc');
  assert.equal(await lost.returned, true);
  const session = api.sessions.get('cnc');
  assert.equal(session.port, newPort);
  assert.equal(session.transport.device, newPort);
  assert.equal(session.esploader, null);
  assert.equal(session.bootloaderDirty, false);
  assert.equal(api.findSessionByPort(oldPort), null);
  assert.equal(api.portReturned(s3Port()), null, 'nothing left waiting');
});

test('a console command is refused while that block is flashing, so no poller resets the chip mid-write', async () => {
  // The guard that stopped the long app write from dying to "Hard resetting
  // via RTS pin": a board that answered as running started the dialog's
  // pollers, and one fired mid-install, reopened the port and reset the
  // chip. ensurePlain now refuses the console while a flash holds the port.
  const consoleSrc = fs.readFileSync(new URL('../client/src/serialConsole.js', import.meta.url), 'utf8');
  assert.match(consoleSrc, /if \(isFlashing\(blockId\)\) throw new Error\('a firmware install is in progress'\)/);
  assert.match(consoleSrc, /import \{ getSession, ensureOpenPlain, isFlashing \}/);
  const flashSrc = fs.readFileSync(new URL('../client/src/serialFlash.js', import.meta.url), 'utf8');
  assert.match(flashSrc, /export function isFlashing/);
  // flash() sets the flag for the whole write and clears it in finally.
  assert.match(flashSrc, /flashing\.add\(blockId\);[\s\S]*?return await flashInner[\s\S]*?flashing\.delete\(blockId\);/);
  // The CNC connectivity poll skips itself while flashing.
  for (const name of ['esp32s3-2io-cnc', 'esp32s3-8io-cnc', 'esp32-devkit-cnc']) {
    const d = JSON.parse(fs.readFileSync(new URL(`../modules/${name}/noditron.module.json`, import.meta.url))).block.blocks[0].props.find((p) => p.name === 'dialog').value;
    assert.ok(d.includes('helpers.serial.isFlashing && helpers.serial.isFlashing()'), name);
  }
});

test('the same SerialPort object coming back is the board back too', async () => {
  const api = flashApiForPorts(8000);
  const port = s3Port();
  const stale = { device: port, disconnect: async () => { throw new Error('must not be torn down'); } };
  api.sessions.set('cnc', { port, transport: stale, esploader: {}, bootloaderDirty: true });
  const lost = api.portLost(port);
  assert.equal(api.portReturned(port), 'cnc');
  assert.equal(await lost.returned, true);
  const session = api.sessions.get('cnc');
  assert.equal(session.port, port);
  assert.notEqual(session.transport, stale);
  assert.equal(session.transport.device, port);
  assert.equal(session.esploader, null);
});

test('a port that stays away past the grace drops its session', async () => {
  const api = flashApiForPorts(30);
  const oldPort = s3Port();
  api.sessions.set('cnc', { port: oldPort, transport: { device: oldPort, disconnect: async () => {} } });
  const lost = api.portLost(oldPort);
  assert.equal(await lost.returned, false);
  assert.equal(api.sessions.has('cnc'), false);
  assert.equal(api.portReturned(s3Port()), null, 'too late: a newcomer, offered as such');
});

test('identify moves over to the port a re-enumerated board came back on', async () => {
  const encoder = new TextEncoder();
  // The dead handle: writes fail, nothing is ever read.
  const dead = { device: { readable: new ReadableStream(), writable: new WritableStream({ write() { throw new Error('gone'); } }) } };
  const session = { transport: dead };
  const api = consoleFor(session);
  api.setLogIncoming(false);
  let controller;
  const readable = new ReadableStream({ start(c) { controller = c; } });
  const alive = { device: { get readable() { return readable; }, writable: new WritableStream({ write(chunk) {
    if (new TextDecoder().decode(chunk).includes('ping')) setTimeout(() => controller.enqueue(encoder.encode('[INFO] CncMod v1.4a build 20260930r | AP=- | IP=- | heap=1 | state=Idle\n')), 5);
  } }) } };
  setTimeout(() => { session.transport = alive; }, 150);
  const info = await api.identify('cnc', { timeoutMs: 2000, pingEveryMs: 50, bootGraceMs: 100 });
  assert.equal(info.verified, true);
  assert.equal(info.kind, 'cnc');
  api.closeConsole('cnc');
});

test('native ESP32-S3 USB uses ROM flashing instead of the unstable RAM stub', () => {
  const flashSource = fs.readFileSync(new URL('../client/src/serialFlash.js', import.meta.url), 'utf8');
  assert.match(flashSource.replace(/\s+/g, ' '), /usbProductId === ESPRESSIF_USB_JTAG_SERIAL_PID/);
  assert.match(flashSource, /await esploader\.detectChip\(\)/);
  assert.match(flashSource, /Using ROM flasher for native USB/);
  // The ROM takes 1KB blocks (the chip class's FLASH_WRITE_SIZE); esptool-js
  // leaves its stub's 16KB in place and the S3 ROM answers 1,5 to that.
  assert.match(flashSource, /esploader\.FLASH_WRITE_SIZE = esploader\.chip\.FLASH_WRITE_SIZE/);
  // The ROM's RTC watchdog resets the chip partway through a long write
  // over USB-Serial/JTAG unless it is disabled first (esptool.py does;
  // the vendored esptool-js's S3 class does not).
  assert.match(flashSource, /await disableRomWatchdogs\(esploader, terminal\)/);
  assert.match(flashSource, /wkey: 0x50d83aa1/);
  assert.match(flashSource, /swdWkey: 0x8f1d312a/);
  // The essential fix: the ROM never attaches its SPI flash on the no-stub
  // path (esptool-js defines flashSpiAttach but never calls it), so the
  // first FLASH_BEGIN hangs. Proven on hardware against this exact bundle.
  assert.match(flashSource, /await esploader\.flashSpiAttach\(0\)/);
  const bundle = fs.readFileSync(new URL('../client/vendor/esptool-js/esptool-js.bundle.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes('flashSpiAttach'), 'the bundle defines flashSpiAttach');
  // Guard the premise: if a bundle update ever starts calling it itself,
  // this one-occurrence assumption (definition only) no longer holds and
  // the manual call may double-attach — revisit then.
  assert.equal(bundle.match(/flashSpiAttach/g).length, 1, 'esptool-js still never calls flashSpiAttach itself');
  assert.doesNotMatch(bundleS3(), /disableWatchdogs/);
});

function bundleS3() {
  const bundle = fs.readFileSync(new URL('../client/vendor/esptool-js/esptool-js.bundle.js', import.meta.url), 'utf8');
  const start = bundle.indexOf('CHIP_NAME="ESP32-S3"');
  assert.ok(start > 0);
  return bundle.slice(start, bundle.indexOf('CHIP_NAME=', start + 1));
}

test('the bundled S3 class takes 1KB ROM blocks and has no watchdog handling of its own', () => {
  const s3 = bundleS3();
  assert.match(s3, /this\.FLASH_WRITE_SIZE=1024/);
  assert.doesNotMatch(s3, /WDTWPROTECT/);
  const flashSource = fs.readFileSync(new URL('../client/src/serialFlash.js', import.meta.url), 'utf8');
  assert.match(flashSource, /compress: session\.esploader\.IS_STUB === true/);
});

for (const name of ['esp32-devkit-logic', 'esp32s3-8io-logic', 'esp32s3-2io-logic']) {
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

// The board's shell ends every reply with `ok` or `error: ...` (see
// serialConsole.shell); lines the board prints on its own in between come
// back with the reply, as they would on a terminal.
function shellDevice(replies) {
  const encoder = new TextEncoder();
  let controller;
  const readable = new ReadableStream({ start(c) { controller = c; } });
  const written = [];
  const device = {
    get readable() { return readable; },
    writable: new WritableStream({ write(chunk) {
      written.push(new TextDecoder().decode(chunk));
      const line = written[written.length - 1].trim();
      const reply = replies[line];
      if (reply) setTimeout(() => controller.enqueue(encoder.encode(reply)), 5);
    } }),
  };
  // Something the board says on its own, unprompted.
  const push = (text) => controller.enqueue(encoder.encode(text));
  return { device, written, push };
}

test('a shell command collects its reply up to ok, or reports the error line', async () => {
  const { device } = shellDevice({
    nodes: 'logic a1d148c4 esp32-s3 v1.2 self\n[TCA9554] EXIO01 pin -> LOW\ncnc 0badf00d v1.4 seen 1s ago via can\nok\n',
    'wifi pw': 'error: select a network first: wifi select <n|ssid>\n',
  });
  const api = consoleFor({ transport: { device } });
  api.setLogIncoming(false);
  const nodes = await api.shell('board', 'nodes', { timeoutMs: 500 });
  assert.equal(nodes.ok, true);
  assert.deepEqual(nodes.lines, ['logic a1d148c4 esp32-s3 v1.2 self', '[TCA9554] EXIO01 pin -> LOW', 'cnc 0badf00d v1.4 seen 1s ago via can']);
  const failed = await api.shell('board', 'wifi pw', { timeoutMs: 500 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /select a network first/);
  const silent = await api.shell('board', 'nothing', { timeoutMs: 100 });
  assert.equal(silent.ok, false);
  assert.equal(silent.error, 'no reply');
  api.closeConsole('board');
});

test('a socket announcement inside a quiet poll is still unsolicited and never quiet', async () => {
  const { device } = shellDevice({ nodes: 'socket in: helloWorld\ncnc 0dd04644 CNC v1.4 self\nok\n' });
  const api = consoleFor({ transport: { device } });
  api.setLogIncoming(false);
  const seen = [];
  const stop = api.subscribeConsoleLines('board', (entry) => seen.push(entry));
  await api.shell('board', 'nodes', { timeoutMs: 500, quiet: true });
  const socket = seen.find((e) => e.line === 'socket in: helloWorld');
  assert.ok(socket, 'the announcement was delivered');
  assert.equal(socket.unsolicited, true);
  assert.equal(socket.quiet, false);
  const reply = seen.find((e) => e.line.startsWith('cnc 0dd04644'));
  assert.equal(reply.quiet, true, 'the poll reply itself stays quiet');
  stop();
  api.closeConsole('board');
});

test('lines the board sends on its own are marked unsolicited; a command reply is not', async () => {
  const { device, push } = shellDevice({ 'can ?': '[CAN] tx ?\nok\n' });
  const api = consoleFor({ transport: { device } });
  api.setLogIncoming(false);
  const seen = [];
  const stop = api.subscribeConsoleLines('board', (entry) => seen.push(entry));
  const sent = await api.shell('board', 'can ?', { timeoutMs: 500 });
  assert.equal(sent.ok, true);
  // The CNC module answers over CAN a moment later, after the ok, while
  // nothing is waiting on the board.
  api.openConsole('board');
  push('[CAN] rx <Idle|MPos:0.000,0.000,0.000>\n');
  await new Promise((r) => setTimeout(r, 30));
  // The line the browser wrote comes through too, marked outgoing, ahead
  // of the board's reply to it.
  assert.deepEqual(seen.filter((e) => e.outgoing).map((e) => e.line), ['can ?']);
  // `[CAN] tx ?` is printed inside the command's reply, but it is the
  // board's own notice about the bus and counts as an announcement.
  assert.deepEqual(seen.filter((e) => !e.unsolicited && !e.outgoing).map((e) => e.line), ['ok']);
  assert.deepEqual(seen.filter((e) => e.unsolicited).map((e) => e.line), ['[CAN] tx ?', '[CAN] rx <Idle|MPos:0.000,0.000,0.000>']);
  // None of it is the app's own housekeeping.
  assert.ok(seen.every((e) => !e.quiet));
  stop();
  api.closeConsole('board');
});

test('an ok that names its command ends the reply like a bare ok', async () => {
  const { device } = shellDevice({ 'ls can': 'log = Off\nmirror = Off\nok ls can\n' });
  const api = consoleFor({ transport: { device } });
  api.setLogIncoming(false);
  const sent = await api.shell('board', 'ls can', { timeoutMs: 500 });
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.lines, ['log = Off', 'mirror = Off']);
  assert.equal(sent.end, 'ok ls can');
  api.closeConsole('board');
});

test('a line from another node, <from>@<port>><text>, is unsolicited even inside a reply', async () => {
  const { device } = shellDevice({ 'ls can': 'cnc@can>unlock\nlog = Off\nok\n' });
  const api = consoleFor({ transport: { device } });
  api.setLogIncoming(false);
  const seen = [];
  const stop = api.subscribeConsoleLines('board', (entry) => seen.push(entry));
  const sent = await api.shell('board', 'ls can', { timeoutMs: 500 });
  assert.equal(sent.ok, true);
  assert.deepEqual(seen.filter((e) => e.unsolicited).map((e) => e.line), ['cnc@can>unlock']);
  assert.deepEqual(seen.filter((e) => !e.unsolicited && !e.outgoing).map((e) => e.line), ['log = Off', 'ok']);
  stop();
  api.closeConsole('board');
});
