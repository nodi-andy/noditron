// A plain-text line/byte console over the *same* Web Serial connection
// serialFlash.js uses for flashing — once a chip is running actual
// firmware (or already was, and was never touched), talking to it isn't
// esptool's SLIP-framed bootloader protocol anymore, just whatever plain
// bytes the firmware's own Serial object reads and writes. conucon's
// esp32_logic already runs a line-based command console during normal
// operation (see its own pollSerialCommands/handleSerialCommand) — `ping`
// identifies it, `design`/`save-design <n>` (added alongside this file)
// read and write its circuit. Nothing here opens a second connection:
// Transport.rawRead already reads without SLIP framing, and a plain
// `device.writable` write bypasses Transport.write's own mandatory SLIP
// framing (there is no raw-write it exposes directly) — both operate on
// the exact same port serialFlash.js's session already holds open.
import { getSession, ensureOpenPlain } from './serialFlash.js';

const consoles = new Map(); // blockId -> { queue: Uint8Array, waiters: [] }

// Makes sure the port is actually open in plain mode (see serialFlash.js's
// own ensureOpenPlain for what that involves — a fresh open, a no-op if
// it's already open and plain, or a full close/reopen if a bootloader
// session tainted it) before any read/write here touches it. When that did
// force a close/reopen, this blockId's own queue/reader is stale — it was
// reading a transport that just got replaced out from under it — so throw
// it out and let the next openConsole() call start clean.
async function ensurePlain(blockId) {
  const before = getSession(blockId);
  if (before?.esploader || before?.bootloaderDirty) closeConsole(blockId);
  await ensureOpenPlain(blockId);
}

// What a circuit sends to the browser over USB (see buildMinimalDesign's
// USB serial chains): a firmware `serial` block on UART0 prints each value
// as its own console line, behind this prefix. Such lines arrive whenever
// the circuit fires, not in answer to anything, so they are taken out of
// the console stream the moment they are complete — before a command
// waiting on its own reply can mistake one for it — and kept per board as
// the latest value received (see getUsbValue).
export const USB_SERIAL_PREFIX = '[USB] ';
const USB_PREFIX_BYTES = new TextEncoder().encode(USB_SERIAL_PREFIX);
const usbValues = new Map(); // blockId -> { value, at }
const ioListeners = new Map(); // blockId -> Set<(pins) => void>

export function subscribeIoChanges(blockId, listener) {
  let listeners = ioListeners.get(blockId);
  if (!listeners) {
    listeners = new Set();
    ioListeners.set(blockId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) ioListeners.delete(blockId);
  };
}

// HIGH/LOW (a Timer's two edges) read as booleans, numbers as numbers,
// anything else as the text it is — the same kinds a wire carries in the
// simulation.
function parseUsbValue(text) {
  if (text === 'HIGH') return true;
  if (text === 'LOW') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

// The last value the board's circuit sent over USB, or undefined when
// nothing has arrived since the board was last (re)connected.
export function getUsbValue(blockId) {
  return usbValues.get(blockId);
}

function takeAsyncLines(state, bytes) {
  const parts = [];
  let keepFrom = 0;
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 10) continue;
    let match = i - lineStart >= USB_PREFIX_BYTES.length;
    for (let k = 0; match && k < USB_PREFIX_BYTES.length; k += 1) {
      if (bytes[lineStart + k] !== USB_PREFIX_BYTES[k]) match = false;
    }
    let consumed = false;
    if (match) {
      const text = new TextDecoder().decode(bytes.slice(lineStart + USB_PREFIX_BYTES.length, i)).replace(/\r$/, '');
      usbValues.set(state.blockId, { value: parseUsbValue(text), at: Date.now() });
      consumed = true;
    } else {
      const text = new TextDecoder().decode(bytes.slice(lineStart, i)).replace(/\r$/, '');
      try {
        const message = JSON.parse(text);
        if (message.type === 'io-change' && Array.isArray(message.pins)) {
          for (const listener of ioListeners.get(state.blockId) || []) listener(message.pins);
          consumed = true;
        }
      } catch { /* Ordinary console line. */ }
    }
    if (consumed) {
      parts.push(bytes.slice(keepFrom, lineStart));
      keepFrom = i + 1;
    }
    lineStart = i + 1;
  }
  if (!parts.length) return bytes;
  parts.push(bytes.slice(keepFrom));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Everything the board says, one readable line per line it sent, instead
// of the per-chunk hex dump esptool-js's own tracing used to bury the
// console in (see serialFlash.js's TRACE_SERIAL). Only whole lines are
// logged, and only once — the bytes stay in the queue for whoever is
// actually waiting on them, this just watches them go past.
export let logIncoming = true;
export function setLogIncoming(on) {
  logIncoming = Boolean(on);
}

// Deliberately its own buffer rather than an index into `state.queue`:
// that queue is spliced by takeUsbLines and drained by waiters, so any
// mark into it goes stale the moment either of them runs. This just sees
// every chunk once, on its way in.
const MAX_LOG_BUFFER = 4096; // a stream with no newline in it must not grow forever
function logCompleteLines(state, chunk) {
  if (!logIncoming) return;
  const text = (state.logBuf || '') + new TextDecoder().decode(chunk);
  const parts = text.split('\n');
  const tail = parts.pop();
  state.logBuf = tail.length > MAX_LOG_BUFFER ? tail.slice(-MAX_LOG_BUFFER) : tail;
  for (const part of parts) {
    const line = part.replace(/\r$/, '');
    if (!line) continue;
    // Only when it actually changes. Live pin state is *polled* (see
    // livePins.js — a request every 150ms for as long as a board is on
    // screen), so the board dutifully answers with the same
    // {"type":"io",...} line several times a second whether anything moved
    // or not. Logging each one buries the lines that carry news. A repeat
    // is still delivered to whoever is waiting on it — this only decides
    // what is worth printing.
    if (line === state.lastLogged) continue;
    state.lastLogged = line;
    console.log('[serial]', line);
  }
}

function appendBytes(state, chunk) {
  logCompleteLines(state, chunk);
  const merged = new Uint8Array(state.queue.length + chunk.length);
  merged.set(state.queue);
  merged.set(chunk, state.queue.length);
  state.queue = takeAsyncLines(state, merged);
  drainWaiters(state);
}

// Line and byte-count waiters share one queue — `save-design`'s own reply
// is exactly that mix (a line, then a raw payload, then another line), so
// both have to draw from the same ordered stream rather than two separate
// buffers that could interleave wrong.
function drainWaiters(state) {
  while (state.waiters.length) {
    const w = state.waiters[0];
    if (w.kind === 'line') {
      const idx = state.queue.indexOf(10); // '\n'
      if (idx === -1) return;
      const line = new TextDecoder().decode(state.queue.slice(0, idx)).replace(/\r$/, '');
      state.queue = state.queue.slice(idx + 1);
      state.waiters.shift();
      w.resolve(line);
    } else {
      if (state.queue.length < w.n) return;
      const bytes = state.queue.slice(0, w.n);
      state.queue = state.queue.slice(w.n);
      state.waiters.shift();
      w.resolve(bytes);
    }
  }
}

function wait(state, waiter, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = state.waiters.indexOf(waiter);
      if (i !== -1) state.waiters.splice(i, 1);
      reject(new Error('Timed out waiting for the device.'));
    }, timeoutMs);
    waiter.resolve = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    state.waiters.push(waiter);
    drainWaiters(state);
  });
}

const readLine = (state, timeoutMs) => wait(state, { kind: 'line' }, timeoutMs);
const readBytes = (state, n, timeoutMs) => (n > 0 ? wait(state, { kind: 'bytes', n }, timeoutMs) : Promise.resolve(new Uint8Array(0)));

export function openConsole(blockId) {
  const session = getSession(blockId);
  if (!session) throw new Error('Not connected — pick a serial port first.');
  let state = consoles.get(blockId);
  if (state) return state;
  state = { queue: new Uint8Array(0), waiters: [], closed: false, blockId };
  consoles.set(blockId, state);
  state.reading = readConsole(state, session.transport);
  return state;
}

async function readConsole(state, transport) {
  // Web Serial replaces readable after a recoverable framing/overflow error.
  // Resume on that stream without reopening (and resetting) the board.
  while (!state.closed && transport.device.readable) {
    let reader;
    try {
      reader = transport.device.readable.getReader();
      state.reader = reader;
      transport.reader = reader;
      while (!state.closed) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value) appendBytes(state, value);
      }
    } catch (err) {
      if (!reader) return; // Another operation owns the port.
      if (!state.closed) console.warn('[serial] Read interrupted:', err.message);
    } finally {
      reader?.releaseLock();
      if (transport.reader === reader) transport.reader = undefined;
      state.reader = null;
    }
  }
}

// Cancels a read that's already blocked waiting for the device's first
// byte — rawRead's own isClosed() is only checked *between* chunks (see
// its own doc), so a silent device would otherwise hang this forever
// without an explicit cancel, same reasoning as Transport.disconnect()'s.
export function closeConsole(blockId) {
  usbValues.delete(blockId);
  const state = consoles.get(blockId);
  if (!state) return;
  state.closed = true;
  consoles.delete(blockId);
  state.reader?.cancel().catch(() => {});
}

// A write to a port whose device has gone never settles — and an ESP32-S3
// on its native USB *does* go: opening the port asserts DTR, which resets
// the chip, which takes its USB device down and brings it back as a fresh
// enumeration. The handle that survives that points at something no longer
// there, and `writer.write()` on it simply never returns. Unbounded, that
// hangs whatever was probing the board forever — the dialog sitting on
// "checking for firmware..." with nothing to time it out. Nothing here is
// worth waiting seconds for, so every write gets a deadline.
const WRITE_TIMEOUT_MS = 1500;

async function writeRaw(blockId, bytes) {
  const session = getSession(blockId);
  if (!session?.transport?.device?.writable) throw new Error('the serial port is closed');
  const writer = session.transport.device.writable.getWriter();
  let timer = null;
  try {
    await Promise.race([
      writer.write(bytes),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the serial port stopped accepting writes')), WRITE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    try {
      writer.releaseLock();
    } catch {
      // A writer whose stream already errored cannot be released; the port
      // is being thrown away either way.
    }
  }
}

async function writeLine(blockId, text) {
  await writeRaw(blockId, new TextEncoder().encode(`${text}\n`));
}

// "Is anything running over there?", asked the way the firmware is most
// likely to hear it.
//
// `?` is not a command, it is a single character the firmware acts on the
// moment it reads it (see esp32_logic's pollSerialCommands: `if (c == '?')
// { printSystemInfo(); continue; }`) — before any line assembly, and so
// regardless of what half-finished line is sitting in its command buffer
// from whatever spoke to it last. `ping` has to survive that buffer to be
// recognised at all: one stray byte with no newline behind it left over
// from a previous session, and `ping` arrives as `…ping` and matches
// nothing.
//
// Both go, in that order, with a newline between them to close out
// anything already buffered. Either one answers with the same [INFO] line,
// and a board that prints it twice costs nothing — identify() returns on
// the first.
const PROBE_BYTES = new TextEncoder().encode('?\nping\n');

async function probe(blockId) {
  await writeRaw(blockId, PROBE_BYTES);
}

async function writeBytes(blockId, bytes) {
  await writeRaw(blockId, bytes);
}

// Deliberately not anchored to the start of the line. The firmware answers
// from inside its own loop, so its reply lands wherever the output happened
// to be — caught on a real board as
//   "[I2C] slave [INFO] LogicMod v1.2 build 20260922a | AP=…"
// where printSystemInfo ran between another message and its newline.
// Anchored with ^, that answer is thrown away and a board that replied
// correctly is reported as having no firmware.
const INFO_RE = /\[INFO] LogicMod v(\S+) build (\S+) \| AP=(\S+) \| IP=(\S+) \| heap=(\d+) \| circuit=(\w+) nCB=(\d+)/;

// Two more lines worth recognising while probing (see identify below).
// The firmware prints this banner once, out of setup(), a second or more
// before it can answer anything — it is proof the app image is there and
// running, and the only thing that justifies waiting out a slow boot.
const BOOTING_RE = /^Logic Module v(\S+) \(build (\S+)\) booting/;
// The ROM's own boot loop on a chip with no valid app image. No amount of
// asking will produce an answer, so stop asking and let the caller offer
// the firmware installer straight away.
const NO_APP_RE = /invalid header|flash read err|waiting for download/i;
// The firmware is there and starting, and the board dies before it can
// finish — measured on a DevKit: banner, then "Brownout detector was
// triggered" 79ms later as WiFi.softAP() powers the radio, then round
// again every 483ms, forever. Indistinguishable from "no firmware" to
// anything that only waits for an answer, so it is called out by name
// rather than left to time out.
//
// Only the panic lines themselves, never the ROM's `rst:0x..` reason: a
// perfectly ordinary boot prints one of those every time (opening the
// port resets the board; esptool's own hard_reset after a flash does
// too), so matching those would report a healthy board as broken. A
// second boot banner inside one probe is the other unambiguous signal —
// whatever the cause, the board restarted while we were talking to it.
const RESET_LOOP_RE = /Brownout detector was triggered|Guru Meditation Error/i;

// Plain `ping` — the same command a human gets from a serial monitor,
// nothing added just for this. Whatever old boot-log lines are still
// sitting in the queue from before this call are irrelevant noise, not a
// stale answer to *this* ping (nothing here could have asked before now),
// so they're discarded up front rather than risking a match against them.
// Every other command function below does the same for the same reason —
// esp32_logic can print an unsolicited line at any time with nothing here
// having asked for it (a delayed "[CIRCUIT] Load failed, retrying in
// 500ms" from a design load that finishes 500ms after the upload that
// triggered it, an [SSID]/[SYSTEM] line, a [WS] connect/disconnect notice,
// ...) — readLine() has no way to tell "this line answers my own request"
// from "this line was already sitting here," so a command that doesn't
// clear the queue first can end up reading some earlier command's leftover
// unsolicited output as if it were its own reply (confirmed live: this is
// exactly what turned a save-design's own READY check into "Unexpected
// response: [CIRCUIT] Load failed, retrying in 500ms").
async function identifyCommand(blockId, { timeoutMs = 3000, pingEveryMs = 500, bootGraceMs = 20000 } = {}) {
  await ensurePlain(blockId);
  const state = openConsole(blockId);
  state.queue = new Uint8Array(0);
  // Asked repeatedly, not once. Opening the port drives DTR/RTS and so
  // resets the board (see serialFlash.releaseResetLines), and the firmware
  // answers nothing at all until setup() has mounted SPIFFS — formatting
  // it, on the first boot after a flash writes a fresh partition table —
  // and brought the AP up, which is seconds later. A single ping sent the
  // moment the port opens is swallowed by Serial.begin() re-initialising
  // the UART, and nothing ever asks again: a board running perfectly well
  // reads as having no firmware. esp32_logic prints no [INFO] line of its
  // own accord either (printSystemInfo runs only from the 'ping' handler
  // and the '?' shortcut), so the answer has to be asked for again once
  // the board's own loop is alive to hear it.
  let deadline = Date.now() + timeoutMs;
  let nextPing = 0;
  let booting = false;
  let banners = 0;
  let version = null;
  // Nothing here reopens the port while waiting, and that is the point.
  //
  // Opening the port resets the board — the S3's USB *is* its serial port,
  // so the host opening it restarts the chip, which its own ROM log says
  // outright: `rst:0x15 (USB_UART_CHIP_RESET)`. A reopen while waiting for
  // the board to boot therefore resets the very boot being waited on. Tried
  // once, and the console filled with nothing but boot banners: the board
  // got as far as printing `[I2C] slave ` — the line its answer is appended
  // to — and was reset again mid-word, over and over.
  //
  // The board needs to be left alone. Ask, wait, ask again; the writes that
  // fail while it is mid-reset are expected and cost nothing but the next
  // 500ms.
  while (Date.now() < deadline) {
    if (Date.now() >= nextPing) {
      try {
        await probe(blockId);
      } catch {
        // Expected while the board is mid-reset and its USB device is
        // away: the write has nowhere to land. Not a reason to do anything
        // drastic — the board is busy booting, and booting ends with it
        // listening. Try again on the next tick.
        nextPing = Date.now() + pingEveryMs;
        continue;
      }
      nextPing = Date.now() + pingEveryMs;
    }
    let line;
    try {
      line = await readLine(state, Math.min(pingEveryMs, Math.max(deadline - Date.now(), 1)));
    } catch {
      continue; // quiet until the next ping is due — ask again
    }
    const m = line.match(INFO_RE);
    if (m) {
      return {
        verified: true,
        version: m[1],
        build: m[2],
        ap: m[3],
        ip: m[4],
        heap: Number(m[5]),
        circuitActive: m[6] === 'active',
        blockCount: Number(m[7]),
      };
    }
    // The boot banner says the app image is there and starting: from here
    // the wait is for a boot to finish rather than for a board that may
    // have nothing on it at all, which earns far more patience than the
    // caller's own budget — a first boot after a flash formats SPIFFS.
    const boot = line.match(BOOTING_RE);
    if (boot) {
      banners += 1;
      version = boot[1];
      if (!booting) {
        booting = true;
        deadline = Math.max(deadline, Date.now() + bootGraceMs);
      }
    }
    // A board that starts its firmware and resets before it can answer is
    // not a board without firmware, and waiting out the full grace period
    // to say so is both slow and wrong. A second banner is the loop; a
    // brownout or panic line names the cause outright.
    //
    // Only claim it is the Logic Module when its own banner was actually
    // seen: a board looping on some *other* firmware panics exactly the
    // same way (seen live — a stale Grbl_ESP32 image null-dereferencing
    // on every boot), and naming the wrong firmware would send whoever
    // reads this looking in the wrong place entirely.
    if (banners > 1 || RESET_LOOP_RE.test(line)) {
      closeConsole(blockId);
      const cause = /Brownout/i.test(line)
        ? ' (brownout — the 3.3V rail collapses as the radio starts)'
        : /Guru Meditation/i.test(line)
          ? ' (its firmware panics on every boot)'
          : '';
      throw new Error(
        version
          ? `Logic Module v${version} is installed but the board keeps resetting${cause}. `
            + 'Check the USB cable and port, or power the board externally.'
          : `The board is resetting in a loop${cause} and cannot answer. `
            + 'Check power first; if it holds up, re-install the firmware — what is on it may not be the Logic Module.',
      );
    }
    if (NO_APP_RE.test(line)) break;
  }
  closeConsole(blockId);
  return { verified: false, booting };
}

async function readDesignCommand(blockId, { timeoutMs = 4000 } = {}) {
  await ensurePlain(blockId);
  const state = openConsole(blockId);
  state.queue = new Uint8Array(0); // see identify()'s own doc on why
  await writeLine(blockId, 'design');
  const begin = await readLine(state, timeoutMs);
  const m = begin.match(/^\[DESIGN] BEGIN (\d+)/);
  if (!m) throw new Error(`Unexpected response: ${begin}`);
  const len = Number(m[1]);
  const bytes = await readBytes(state, len, timeoutMs);
  await readLine(state, timeoutMs); // the blank line after the raw payload
  await readLine(state, timeoutMs); // "[DESIGN] END"
  const text = new TextDecoder().decode(bytes);
  return text ? JSON.parse(text) : { blocks: [] };
}

// Not a general graph compiler — esp32_logic's own circuit model is belts
// on a grid (Factorio-style signal routing), nodigraph's is named ports and
// point-to-point wires between arbitrary blocks — but the two shapes this
// container's own allowedChildKinds actually permits (see
// containerRestrictions.js and modules/esp32-devkit's own prop: only
// digital-io and timer children are addable inside an ESP32 DevKit at all)
// both have a direct, mechanical translation into one din/timer, one belt,
// one dout, exactly three grid cells wide — a belt only has to land
// somewhere inside the destination block's own footprint to deliver (see
// esp32_logic's deliverToBlocks/circuitFireAll — it checks the whole
// bounding box, not a specific port cell). That's the whole reason a
// connected board can run this forwarding completely on its own now, no
// browser required to keep pushing values across — see this block's own
// html prop (DIGITAL_IO_HTML in palette.js) for the client-side half of
// that story, which now only *observes* a live pin rather than driving one
// from a wire.
//
// Each wired pair gets its own row (gy = row*3) specifically so two
// unrelated pairs' belts can never cross through a third block's own
// footprint — din/dout/timer all default to a 2x2 cell, "row*3" leaves
// exactly one empty row between pairs, same margin the single belt cell
// already uses horizontally (source@col0, belt@col+2, dout@col+3). A pin
// or timer that's part of more than one connection (fan-out/fan-in) only
// gets its first pairing routed this way; every other occurrence still
// gets declared (see the unconnected-pins pass below, Bool children only —
// an unwired Timer drives nothing, so it's simply skipped) but without a
// second belt, since this simple per-row layout has no way to route two
// different partners to the same fixed position without risking a
// collision.
function collapsePassThroughs(childBlocks, connections) {
  const propOf = (block, name) => (block.props || []).find((p) => p.name === name)?.value;
  const pinlessBools = new Set(
    childBlocks
      .filter((b) => propOf(b, 'noditronKind') === 'digital-io')
      .filter((b) => {
        const pin = propOf(b, 'pin');
        return pin === null || pin === undefined || pin === '';
      })
      .map((b) => b.id),
  );
  // A Data block fed through its `in` passes that value on too — its own
  // fn is `inputs.in !== undefined ? inputs.in : props.value` — and so is
  // traced through the same way. One fed by nothing is a real source: its
  // own value (see the USB serial chains in buildMinimalDesign).
  const dataBlocks = new Set(childBlocks.filter((b) => propOf(b, 'noditronKind') === 'data').map((b) => b.id));
  const passThrough = new Set([...pinlessBools, ...dataBlocks]);
  if (!passThrough.size) return connections;
  const byId = new Map(childBlocks.map((b) => [b.id, b]));
  const portNameOf = (blockId, portId) => {
    const block = byId.get(blockId);
    const pin = (block?.ports || []).find((p) => p.id === portId);
    return (block?.logicalPorts || []).find((l) => l.id === pin?.logicalId)?.name ?? null;
  };
  const feedOf = (blockId) => connections.find((c) => c.targetBlockId === blockId && portNameOf(blockId, c.targetPortId) === 'in');
  const out = [];
  for (const conn of connections) {
    if (passThrough.has(conn.targetBlockId)) continue;
    let source = conn;
    const seen = new Set();
    while (passThrough.has(source.sourceBlockId) && !seen.has(source.sourceBlockId)) {
      seen.add(source.sourceBlockId);
      const feed = feedOf(source.sourceBlockId);
      if (!feed) break;
      source = feed;
    }
    if (pinlessBools.has(source.sourceBlockId)) continue; // a Bool fed by nothing: a manual value the board cannot hold
    out.push({ ...conn, sourceBlockId: source.sourceBlockId, sourcePortId: source.sourcePortId });
  }
  return out;
}

export function buildMinimalDesign(childBlocks, connections = []) {
  const blocks = [];
  let nextBlockId = 1;

  const pinChildren = childBlocks.filter((c) => {
    if ((c.props || []).find((p) => p.name === 'noditronKind')?.value !== 'digital-io') return false;
    const pin = (c.props || []).find((p) => p.name === 'pin')?.value;
    return pin !== null && pin !== undefined && pin !== '';
  });
  const timerChildren = childBlocks.filter((c) => (c.props || []).find((p) => p.name === 'noditronKind')?.value === 'timer');
  const andChildren = childBlocks.filter((c) => (c.props || []).find((p) => p.name === 'noditronKind')?.value === 'and');
  const dataChildren = childBlocks.filter((c) => (c.props || []).find((p) => p.name === 'noditronKind')?.value === 'data');

  // A Bool with no pin of its own and a wire into its `in` only passes a
  // value along — the board has nothing to run for it. GPIO0 → Bool → AND
  // is, on the board, GPIO0 → AND: a wire leaving such a Bool is traced
  // back to whatever feeds its `in`, and the wire into it is dropped. Left
  // in place, the AND's input had no source the board could run and was
  // never connected at all, so the AND never fired.
  connections = collapsePassThroughs(childBlocks, connections);

  // A connection only carries block ids/port ids, not the logical port name
  // ('a' vs 'b' vs 'out') -- resolved the same way runtime.js's own
  // logicalName() does: the port object's logicalId looked up in the
  // block's own logicalPorts.
  function portName(block, portId) {
    const pin = (block.ports || []).find((p) => p.id === portId);
    const lp = pin && (block.logicalPorts || []).find((l) => l.id === pin.logicalId);
    return lp ? lp.name : null;
  }

  const idByChildId = new Map(); // nodigraph child block id -> conucon block id

  function placeBool(child, gx, gy) {
    if (idByChildId.has(child.id)) return idByChildId.get(child.id);
    const pin = Number((child.props || []).find((p) => p.name === 'pin')?.value);
    const direction = (child.props || []).find((p) => p.name === 'direction')?.value === 'output' ? 'dout' : 'din';
    const exio = Number((child.props || []).find((p) => p.name === 'exio')?.value);
    const id = nextBlockId;
    nextBlockId += 1;
    idByChildId.set(child.id, id);
    blocks.push({
      id,
      type: direction,
      gx,
      gy,
      data: direction === 'din' ? { gpio: pin, emitOnChange: true } : exio >= 1 && exio <= 8 ? { exio } : { gpio: pin },
    });
    return id;
  }

  // Reads T_ON/T_OFF exactly the way this block's own fn prop does locally
  // (see TIMER_FN in palette.js: helpers.childValue('T_ON')/('T_OFF')) —
  // same two child Data blocks, same 500ms default each, so a Timer's
  // simulated on-screen behavior and what actually runs on the board once
  // wired agree on the same interval.
  function placeTimer(child, gx, gy) {
    if (idByChildId.has(child.id)) return idByChildId.get(child.id);
    const kids = child.children ? Array.from(child.children.blocks.values()) : [];
    const onTime = Number(kids.find((k) => k.name === 'T_ON')?.props?.find((p) => p.name === 'value')?.value) || 500;
    const offTime = Number(kids.find((k) => k.name === 'T_OFF')?.props?.find((p) => p.name === 'value')?.value) || 500;
    const id = nextBlockId;
    nextBlockId += 1;
    idByChildId.set(child.id, id);
    blocks.push({ id, type: 'timer', gx, gy, data: { onTime, offTime, mode: 'periodic' } });
    return id;
  }

  // Places whichever of the two kinds this container's allowedChildKinds
  // actually permits as a signal source (Bool Input or Timer); returns
  // false if `child` is neither, or is already placed elsewhere.
  function placeSource(child, gx, gy) {
    if (!child || idByChildId.has(child.id)) return false;
    if (pinChildren.includes(child)) {
      const dir = (child.props || []).find((p) => p.name === 'direction')?.value === 'output' ? 'output' : 'input';
      if (dir !== 'input') return false; // an Output pin can't be a source
      placeBool(child, gx, gy);
      return true;
    }
    if (timerChildren.includes(child)) {
      placeTimer(child, gx, gy);
      return true;
    }
    return false;
  }

  let row = 0;

  // AND: two inputs need two separate source blocks landing on two
  // different rows of its own 2-tall footprint (conucon's own `and` block
  // type — see esp32_logic's deliverToBlocks) — a fixed, hand-traced
  // 5-row-tall, 8-column-wide layout, not the general single-row-pitch
  // packer the simple pairs below use. Traced cell-by-cell against
  // circuitFireAll/deliverToBlocks to confirm no belt here ever sits
  // inside another block's own perimeter-scan zone (which would make that
  // *other* block's firing spuriously re-trigger this belt too):
  //   sourceA @ (0,0)      -- feeds 'a' via belt (2,0) dir E
  //   sourceB @ (0,3)      -- feeds 'b' via belts (2,3) N -> (2,2) E -> (3,2) N
  //   and     @ (3,0)      -- inputs at (3,0)='a', (3,1)='b'; output edge col 5
  //   dout    @ (6,0)      -- fed via belt (5,0) dir E
  // Each AND group consumes 2 row-slots (row*3 pitch, 6 rows) so the next
  // slot always leaves at least one empty row below this shape's own
  // 5 rows, same margin every other group already keeps.
  for (const andChild of andChildren) {
    if (idByChildId.has(andChild.id)) continue;
    const outConn = connections.find((c) => c.sourceBlockId === andChild.id && portName(andChild, c.sourcePortId) === 'out');
    if (!outConn) continue; // nothing listening to this AND's output -- nothing to compile
    const target = pinChildren.find((c) => c.id === outConn.targetBlockId);
    if (!target) continue;
    const targetDir = (target.props || []).find((p) => p.name === 'direction')?.value === 'output' ? 'output' : 'input';
    if (targetDir !== 'output' || idByChildId.has(target.id)) continue;

    const aConn = connections.find((c) => c.targetBlockId === andChild.id && portName(andChild, c.targetPortId) === 'a');
    const bConn = connections.find((c) => c.targetBlockId === andChild.id && portName(andChild, c.targetPortId) === 'b');
    const aSource = aConn && (pinChildren.find((c) => c.id === aConn.sourceBlockId) || timerChildren.find((c) => c.id === aConn.sourceBlockId));
    const bSource = bConn && (pinChildren.find((c) => c.id === bConn.sourceBlockId) || timerChildren.find((c) => c.id === bConn.sourceBlockId));

    const base = row * 3;
    const gotA = placeSource(aSource, 0, base);
    const gotB = placeSource(bSource, 0, base + 3);
    const andId = nextBlockId;
    nextBlockId += 1;
    idByChildId.set(andChild.id, andId);
    blocks.push({ id: andId, type: 'and', gx: 3, gy: base });
    if (gotA) { blocks.push({ id: nextBlockId, type: 'belt', gx: 2, gy: base, data: { dir: 'E' } }); nextBlockId += 1; }
    if (gotB) {
      blocks.push({ id: nextBlockId, type: 'belt', gx: 2, gy: base + 3, data: { dir: 'N' } }); nextBlockId += 1;
      blocks.push({ id: nextBlockId, type: 'belt', gx: 2, gy: base + 2, data: { dir: 'E' } }); nextBlockId += 1;
      blocks.push({ id: nextBlockId, type: 'belt', gx: 3, gy: base + 2, data: { dir: 'N' } }); nextBlockId += 1;
    }
    placeBool(target, 6, base);
    blocks.push({ id: nextBlockId, type: 'belt', gx: 5, gy: base, data: { dir: 'E' } });
    nextBlockId += 1;
    row += 2;
  }

  for (const conn of connections) {
    const boolSource = pinChildren.find((c) => c.id === conn.sourceBlockId);
    const timerSource = timerChildren.find((c) => c.id === conn.sourceBlockId);
    const dataSource = dataChildren.find((c) => c.id === conn.sourceBlockId);
    const target = pinChildren.find((c) => c.id === conn.targetBlockId);
    if (!target) continue;
    const targetDir = (target.props || []).find((p) => p.name === 'direction')?.value === 'output' ? 'output' : 'input';
    if (targetDir !== 'output') continue; // only driving a real Output pin has firmware meaning
    if (idByChildId.has(target.id)) continue; // see fan-out/fan-in note above

    if (dataSource) {
      // A constant connected directly to a hardware sink is sent once when
      // the circuit loads. The boot block wakes the firmware data block;
      // the latter emits its configured value into the target (CAN Out is
      // represented as a synthetic target and rewritten after this pass).
      const base = row * 3;
      blocks.push({ id: nextBlockId++, type: 'boot', gx: 0, gy: base, data: { delay: 100 } });
      blocks.push({ id: nextBlockId++, type: 'belt', gx: 2, gy: base, data: { dir: 'E' } });
      const dataId = nextBlockId++;
      idByChildId.set(dataSource.id, dataId);
      blocks.push({ id: dataId, type: 'data', gx: 3, gy: base, data: { value: String((dataSource.props || []).find((p) => p.name === 'value')?.value ?? '') } });
      blocks.push({ id: nextBlockId++, type: 'belt', gx: 5, gy: base, data: { dir: 'E' } });
      placeBool(target, 6, base);
      row += 1;
      continue;
    } else if (boolSource) {
      const sourceDir = (boolSource.props || []).find((p) => p.name === 'direction')?.value === 'output' ? 'output' : 'input';
      if (sourceDir !== 'input') continue; // Bool source has to be an Input, i.e. the wire is din -> dout
      if (idByChildId.has(boolSource.id)) continue;
      placeBool(boolSource, 0, row * 3);
    } else if (timerSource) {
      if (idByChildId.has(timerSource.id)) continue;
      placeTimer(timerSource, 0, row * 3);
    } else {
      continue; // e.g. an AND's own output wire, already handled above
    }
    placeBool(target, 3, row * 3);
    blocks.push({ id: nextBlockId, type: 'belt', gx: 2, gy: row * 3, data: { dir: 'E' } });
    nextBlockId += 1;
    row += 1;
  }

  // USB serial: a wire into the board's USB pin (see devkitCircuit's
  // usb-serial synthetic target) ends in a firmware `serial` block on UART0,
  // which prints each value it receives to the USB console behind
  // USB_SERIAL_PREFIX, for the browser to pick up (see getUsbValue).
  //   Data (fed by nothing): its value, resent on a timer every
  //     USB_RESEND_MS so the browser has it whenever it connects —
  //     timer @ (0,r), data @ (3,r), serial @ (6,r), belts between.
  //   Anything placeSource can run (a Timer, a GPIO input): its own value,
  //     straight in — source @ (0,r), serial @ (3,r).
  // Same single-row shape and 3-row pitch as the pairs above.
  const USB_RESEND_MS = 500;
  const kindOfBlock = (c) => (c.props || []).find((p) => p.name === 'noditronKind')?.value;
  const usbTargets = childBlocks.filter((c) => kindOfBlock(c) === 'usb-serial');
  for (const conn of connections) {
    if (!usbTargets.some((c) => c.id === conn.targetBlockId)) continue;
    const source = childBlocks.find((c) => c.id === conn.sourceBlockId);
    if (!source || idByChildId.has(source.id)) continue;
    const base = row * 3;
    const serialBlock = (gx) => ({ id: nextBlockId++, type: 'serial', gx, gy: base, data: { uart: 0, baud: 115200, prefix: USB_SERIAL_PREFIX } });
    const belt = (gx) => ({ id: nextBlockId++, type: 'belt', gx, gy: base, data: { dir: 'E' } });
    if (kindOfBlock(source) === 'data') {
      const value = String((source.props || []).find((p) => p.name === 'value')?.value ?? '');
      blocks.push({ id: nextBlockId++, type: 'timer', gx: 0, gy: base, data: { onTime: USB_RESEND_MS, offTime: USB_RESEND_MS, mode: 'periodic' } });
      blocks.push(belt(2));
      const dataId = nextBlockId++;
      idByChildId.set(source.id, dataId);
      blocks.push({ id: dataId, type: 'data', gx: 3, gy: base, data: { value } });
      blocks.push(belt(5));
      blocks.push(serialBlock(6));
    } else {
      if (!placeSource(source, 0, base)) continue;
      blocks.push(belt(2));
      blocks.push(serialBlock(3));
    }
    row += 1;
  }

  // Anything left unwired (or a repeat occurrence of an already-wired pin,
  // per the fan-out/fan-in note above) still gets declared on its own row,
  // exactly like this always did before wiring existed at all. Timers and
  // ANDs aren't included here -- one with nothing wired to it drives
  // nothing, so there's no reason to spend a block slot declaring it.
  let col = 0;
  for (const child of pinChildren) {
    if (idByChildId.has(child.id)) continue;
    placeBool(child, col * 3, row * 3);
    col += 1;
  }

  return { blocks, nextId: nextBlockId };
}

// Direct hardware override of one output pin — serial mirror of the
// WebSocket {"type":"io",...} message esp32_logic's own browser circuit
// editor already sends for live control (see `io <gpio> <0|1>`, added
// alongside this file). Bypasses circuit logic entirely, same as that
// message does; not a substitute for sendDesign, which only ever declares
// pins, never drives them.
async function setPinCommand(blockId, gpio, state, { timeoutMs = 2000 } = {}) {
  await ensurePlain(blockId);
  const consoleState = openConsole(blockId);
  consoleState.queue = new Uint8Array(0); // see identify()'s own doc on why
  await writeLine(blockId, `io ${gpio} ${state ? 1 : 0}`);
  const reply = await readLine(consoleState, timeoutMs);
  if (!/^\[IO] gpio=/.test(reply)) throw new Error(reply || 'Set pin failed.');
  return reply;
}

// Current gpio/output/state for every pin the board's loaded circuit
// declared — serial mirror of broadcastIO()'s WebSocket payload (see `pins`).
async function readPinsCommand(blockId, { timeoutMs = 2000, inputs = [] } = {}) {
  await ensurePlain(blockId);
  const consoleState = openConsole(blockId);
  consoleState.queue = new Uint8Array(0); // see identify()'s own doc on why
  const pins = [...new Set(inputs.filter(pin => Number.isInteger(pin) && pin >= 0 && pin <= 48))];
  await writeLine(blockId, pins.length ? `pins ${pins.join(',')}` : 'pins');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = await readLine(consoleState, Math.max(1, deadline - Date.now()));
    try {
      const doc = JSON.parse(line);
      if (doc.type === 'io' && Array.isArray(doc.pins)) return doc.pins;
    } catch { /* Unsolicited boot/circuit log; keep waiting for this reply. */ }
  }
  throw new Error('Timed out waiting for pin states.');
}

async function sendDesignCommand(blockId, design, { timeoutMs = 5000 } = {}) {
  await ensurePlain(blockId);
  const state = openConsole(blockId);
  state.queue = new Uint8Array(0); // see identify()'s own doc on why
  const bytes = new TextEncoder().encode(JSON.stringify(design));
  await writeLine(blockId, `save-design ${bytes.length}`);
  const ready = await readLine(state, timeoutMs);
  if (!/^\[DESIGN] READY/.test(ready)) throw new Error(`Unexpected response: ${ready}`);
  await writeBytes(blockId, bytes);
  const result = await readLine(state, timeoutMs);
  if (!/Saved \d+ bytes OK/.test(result)) throw new Error(result || 'Save failed.');
  return result;
}

// Every command shares one byte stream. In particular, polling must never
// consume the READY/Saved reply belonging to a circuit upload.
const commandQueues = new Map();
function queueCommand(blockId, run) {
  const previous = commandQueues.get(blockId) || Promise.resolve();
  const result = previous.catch(() => {}).then(run);
  commandQueues.set(blockId, result);
  const clear = () => { if (commandQueues.get(blockId) === result) commandQueues.delete(blockId); };
  result.then(clear, clear);
  return result;
}

export function identify(blockId, ...args) {
  return queueCommand(blockId, () => identifyCommand(blockId, ...args));
}

export function readDesign(blockId, ...args) {
  return queueCommand(blockId, () => readDesignCommand(blockId, ...args));
}

export function setPin(blockId, ...args) {
  return queueCommand(blockId, () => setPinCommand(blockId, ...args));
}

export function readPins(blockId, ...args) {
  return queueCommand(blockId, () => readPinsCommand(blockId, ...args));
}

export function sendDesign(blockId, ...args) {
  return queueCommand(blockId, () => sendDesignCommand(blockId, ...args));
}
