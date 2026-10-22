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
import { getSession, ensureOpenPlain, isFlashing } from './serialFlash.js';

const consoles = new Map(); // blockId -> { queue: Uint8Array, waiters: [] }

// A block reached through another board's link (see canBridge.js): the
// resolver says which, as `{ bridgeId, target }` — the bridge's block id
// and the name the far node answers to. Every module shell has
// `node <name> <line>`, which runs <line> on that node and prints its
// answer, so through the bridge a line is `node <target> <line>` and the
// reply lines are the far board's own. Nothing else here changes: shell()
// and identify() below ask the resolver first.
let bridgeResolver = () => null;
export function setBridgeResolver(fn) {
  bridgeResolver = fn || (() => null);
}
export function bridgeFor(blockId) {
  if (getSession(blockId)) return null;
  return bridgeResolver(blockId) || null;
}

// Makes sure the port is actually open in plain mode (see serialFlash.js's
// own ensureOpenPlain for what that involves — a fresh open, a no-op if
// it's already open and plain, or a full close/reopen if a bootloader
// session tainted it) before any read/write here touches it. When that did
// force a close/reopen, this blockId's own queue/reader is stale — it was
// reading a transport that just got replaced out from under it — so throw
// it out and let the next openConsole() call start clean.
async function ensurePlain(blockId) {
  // A firmware install owns the port; reopening it here (which ensureOpenPlain
  // does whenever a bootloader session is live) would reset the chip and
  // steal the reader mid-write. A stray poll waits for the next connect
  // instead (see serialFlash.isFlashing).
  if (isFlashing(blockId)) throw new Error('a firmware install is in progress');
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

// A wired circuit's trace (firmware `trace on`, see buildWiredDesign): one
// `{"type":"blk","id":N,"o":port,"v":value}` per block output as it fires,
// `{"type":"blk","id":N,"sel":i}` per route selection — the firmware's ids,
// which the design maps to drawn blocks (`ref`). Taken out of the stream
// like io-change, so no command reply is ever mistaken for one.
const traceListeners = new Map(); // blockId -> Set<(message) => void>

export function subscribeTrace(blockId, listener) {
  let listeners = traceListeners.get(blockId);
  if (!listeners) {
    listeners = new Set();
    traceListeners.set(blockId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) traceListeners.delete(blockId);
  };
}

// A CNC's status report pushed to this board because a panel here watches
// that CNC over the bus (firmware 20261018m on: `node <cnc> cnc ...` makes
// the asker a watcher, see conucon's cncWatch): `<from>@push><report>`, at
// every change of grbl's state and four times a second while it moves.
// Taken out of the stream like io-change, so no command reply ever holds
// one, and handed to every subscribePushes listener with the CNC's name or
// id, whichever board it came through.
export const PUSH_RE = /^([\w?*-]+)@push>(.*)$/;
const pushListeners = new Set(); // ({ from, line, via }) => void

export function subscribePushes(listener) {
  pushListeners.add(listener);
  return () => pushListeners.delete(listener);
}

function notifyPush(from, line, via) {
  for (const listener of pushListeners) {
    try {
      listener({ from, line, via });
    } catch {
      // A listener's own error is not the link's problem.
    }
  }
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
      const push = text.match(PUSH_RE);
      if (push) {
        notifyPush(push[1], push[2], state.blockId);
        consumed = true;
      }
      if (!consumed) try {
        const message = JSON.parse(text);
        if (message.type === 'io-change' && Array.isArray(message.pins)) {
          for (const listener of ioListeners.get(state.blockId) || []) listener(message.pins);
          consumed = true;
        } else if (message.type === 'blk' && Number.isInteger(message.id)) {
          for (const listener of traceListeners.get(state.blockId) || []) listener(message);
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
// What a console line is compared against to tell a repeat (see
// logCompleteLines): a JSON line against the last one of its `type`, an
// `ok <command>` against the last ok for that command, any other line
// against the last other line.
function repeatKindOf(line) {
  if (line.startsWith('{')) {
    try { return `json:${JSON.parse(line).type ?? ''}`; } catch { /* not JSON after all */ }
  }
  const ok = /^ok\s+(\S+)/.exec(line);
  if (ok) return `ok:${ok[1]}`;
  return 'line';
}

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
    // livePins.js — a `pins` request every few seconds for as long as a
    // board is on screen), so the board dutifully answers with the same
    // {"type":"io",...} line whether anything moved or not. Logging each
    // one buries the lines that carry news. A repeat is compared with the
    // last line of its own kind, not the last line: every answer ends in
    // its `ok pins ...`, so the io line never followed itself and printed
    // every time. A repeat is still delivered to whoever is waiting on
    // it — this only decides what is worth printing.
    const kind = repeatKindOf(line);
    if (state.lastLoggedByKind?.get(kind) === line) continue;
    (state.lastLoggedByKind ||= new Map()).set(kind, line);
    console.log('[serial]', line);
  }
}

// Every complete console line, to whoever wants to watch the link — the
// dialog's shell box. `unsolicited` is true for a line that arrived while
// no command was waiting on this board: a CAN reply coming back after
// `can <text>` has already been answered with `ok`, a circuit's [USB]
// line, a board log. Lines inside a command's reply are that command's
// and reach its caller through the command itself.
// Each listener gets every line that crosses the link, both ways:
//   { line, unsolicited }          a line the board sent (unsolicited: no
//                                  command was waiting on it)
//   { line, outgoing: true }       a line this browser sent (see writeLine)
// plus `quiet: true` on the traffic of a quiet command — one the app sends
// on its own behalf (pin polling, the dialog's status refreshes, identify,
// a design save) rather than the user, so a terminal view can leave it out
// and still show everything the user or a wire put on the link.
// What a board says on its own account, whatever else is going on: a line
// that reached it from another node (`<from>@<port>><text>` — `cnc@can>ok`,
// `a1d148c4@socket>hello`), a circuit's [USB] value, CAN/socket/node/WiFi/OTA
// notices. See dispatchLines.
// grbl built into the board answers after the board's own `ok` (`cnc>...`,
// and `cnc@can<...` for a line another node sent it): by then one of the
// app's queued polls has usually started, and the answer was taken for
// that poll's and hidden — `cnc unlock` in the shell showed nothing.
// The app never sends `cnc` lines itself, so these are always shown.
const ANNOUNCEMENT_RE = /^([\w?*-]+@\w+>|cnc>|cnc@can<|socket (in|out): |\[(USB|CAN|SOCKET|NODES|WIFI|OTA)\] )/;
const lineListeners = new Map(); // blockId -> Set<(event) => void>
const activeCommands = new Map(); // blockId -> count of commands in flight
const quietCommands = new Map(); // blockId -> count of quiet commands in flight

function notifyLineListeners(blockId, event) {
  for (const listener of lineListeners.get(blockId) || []) {
    try {
      listener(event);
    } catch {
      // A listener's own error is not the link's problem.
    }
  }
}

export function subscribeConsoleLines(blockId, listener) {
  let set = lineListeners.get(blockId);
  if (!set) {
    set = new Set();
    lineListeners.set(blockId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) lineListeners.delete(blockId);
  };
}

function dispatchLines(state, chunk) {
  const listeners = lineListeners.get(state.blockId);
  if (!listeners?.size) {
    state.lineBuf = '';
    return;
  }
  const text = (state.lineBuf || '') + new TextDecoder().decode(chunk);
  const parts = text.split('\n');
  const tail = parts.pop();
  state.lineBuf = tail.length > MAX_LOG_BUFFER ? tail.slice(-MAX_LOG_BUFFER) : tail;
  const inCommand = activeCommands.get(state.blockId) > 0;
  const inQuiet = inCommand && quietCommands.get(state.blockId) > 0;
  for (const part of parts) {
    const line = part.replace(/\r$/, '');
    if (!line) continue;
    // A line the board prints on its own can land in the middle of a
    // command's reply — the socket's `socket in:`/`socket out:` most of
    // all, since the dialog polls the board every few seconds. It is
    // still the board's own announcement: unsolicited, and never quiet,
    // or the socket traffic would vanish from the box whenever a poll
    // happened to be in flight.
    // A pushed report is the CNC panel's (subscribePushes), four a second
    // while the machine moves: never a line for the shell's terminal.
    if (PUSH_RE.test(line)) {
      notifyLineListeners(state.blockId, { line, unsolicited: true, quiet: true });
      continue;
    }
    const announcement = ANNOUNCEMENT_RE.test(line);
    if (!announcement && isLateQuietOk(state.blockId, line)) {
      notifyLineListeners(state.blockId, { line, unsolicited: false, quiet: true });
      continue;
    }
    const unsolicited = !inCommand || announcement;
    const quiet = inQuiet && !announcement;
    notifyLineListeners(state.blockId, { line, unsolicited, quiet });
  }
}

function appendBytes(state, chunk) {
  logCompleteLines(state, chunk);
  dispatchLines(state, chunk);
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

// The console of a link opened under one id, continued under another —
// the Add Block window identifies a board on a temporary id, then places
// the block and hands the link over (serialFlash.adoptSession). The
// reader keeps running on the same transport; only the id its lines are
// filed under changes. Closing and reopening instead would race the old
// reader's cancel against the new reader's lock on the same stream, and a
// console that lost that race never reads a byte.
export function adoptConsole(fromId, toId) {
  const state = consoles.get(fromId);
  if (state) {
    consoles.delete(fromId);
    state.blockId = toId;
    consoles.set(toId, state);
  }
  const usb = usbValues.get(fromId);
  if (usb) {
    usbValues.delete(fromId);
    usbValues.set(toId, usb);
  }
  return state || null;
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

// `via` (optional) names what put the line on the link when it was not
// typed: 'socket' for a wire's value into the board's socket (see
// socketLink.js), so a terminal view can say so.
async function writeLine(blockId, text, { via = null } = {}) {
  await writeRaw(blockId, new TextEncoder().encode(`${text}\n`));
  const quiet = quietCommands.get(blockId) > 0;
  if (quiet) rememberQuietLine(blockId, String(text));
  notifyLineListeners(blockId, { line: String(text), outgoing: true, unsolicited: false, quiet, via });
}

// A quiet command can be done before its `ok <command>` terminator
// arrives: the pin poll returns on its JSON line, so the `ok pins 1,2,...`
// after it landed with nothing waiting and showed in the terminal as
// something the board said on its own, every poll. The quiet lines sent
// in the last few seconds are kept, and an ok that names one of them is
// that command's traffic (see isLateQuietOk).
const QUIET_OK_WINDOW_MS = 5000;
const recentQuietLines = new Map(); // blockId -> [{ line, at }]
function rememberQuietLine(blockId, line) {
  const now = Date.now();
  const list = (recentQuietLines.get(blockId) || []).filter((entry) => now - entry.at < QUIET_OK_WINDOW_MS);
  list.push({ line, at: now });
  recentQuietLines.set(blockId, list.slice(-16));
}
// The firmware's ok echoes the line it answers, cut to 45 characters and
// `...` when longer (conucon's shellOk).
function isLateQuietOk(blockId, line) {
  const match = /^ok (.+)$/.exec(line);
  if (!match) return false;
  const echoed = match[1];
  const now = Date.now();
  const list = recentQuietLines.get(blockId) || [];
  const index = list.findIndex((entry) => now - entry.at < QUIET_OK_WINDOW_MS
    && (entry.line === echoed || (echoed.endsWith('...') && entry.line.startsWith(echoed.slice(0, -3)))));
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
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
// A newline first ends whatever half line the board's buffer holds, so
// `ping` arrives whole. (`?` used to go first; it is grbl's status report
// on the CNC and the S3 no longer answers it either.)
const PROBE_BYTES = new TextEncoder().encode('\nping\n');

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
// Two families answer this way: the Logic Module (`circuit=… nCB=…` tail)
// and the CNC module (`state=…` tail, see esp32_cnc's Module.cpp) — the
// same first line otherwise, so one identify() covers both and reports
// which it found as `kind`.
const INFO_RE = /\[INFO] (noditron|LogicMod|CncMod) v(\S+) build (\S+) \| AP=(\S+) \| IP=(\S+) \| heap=(\d+) \| (.*)$/;

// The second [INFO] line names the node: `node=<id> type=<logic|cnc>` and
// then key=value words — `board=<hardware>` (builds 20260930a and later,
// see moduleDiscovery.HARDWARE), `name=<node name>` (the CNC), and others
// this does not read. Null for any other line.
const NODE_LINE_RE = /^\[INFO] node=([0-9a-f]{8}) type=(\w+)((?:\s+\w+=\S*)*)/;
export function parseNodeLine(line) {
  const m = String(line || '').replace(/\r$/, '').match(NODE_LINE_RE);
  if (!m) return null;
  const fields = {};
  for (const word of m[3].trim().split(/\s+/)) {
    const eq = word.indexOf('=');
    if (eq > 0) fields[word.slice(0, eq)] = word.slice(eq + 1);
  }
  return { node: m[1], type: m[2], board: fields.board || null, name: fields.name || null };
}

// Two more lines worth recognising while probing (see identify below).
// The firmware prints this banner once, out of setup(), a second or more
// before it can answer anything — it is proof the app image is there and
// running, and the only thing that justifies waiting out a slow boot.
const BOOTING_RE = /^(?:noditron|Logic Module) v(\S+) \(build (\S+)\) booting/;
// The CNC module's core says it is starting differently: grbl's banner, and
// then its WiFi join chatter for up to twenty seconds while the port that
// was just opened (which reset the board) is still being brought up. Any
// of these earns the same patience the Logic Module's banner does.
const GRBL_BOOTING_RE = /^Grbl \S+ \[|^\[MSG:(Connecting|Client Started|Cannot connect|Local access point|HTTP Started)/;
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
  let state = openConsole(blockId);
  state.queue = new Uint8Array(0);
  let transport = getSession(blockId)?.transport;
  let rejoined = 0;
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
    // The one exception: the board came back on a new port while this
    // waited (see serialFlash.portReturned — its USB device re-enumerated
    // and the session now holds the fresh handle). The reader here is on
    // the dead one, so the console moves over: open the new port and ask
    // there. Bounded, so a board that re-enumerates on every open cannot
    // keep this going forever.
    const now = getSession(blockId);
    if (now && now.transport !== transport && rejoined < 2) {
      rejoined += 1;
      closeConsole(blockId);
      try {
        await ensurePlain(blockId);
        state = openConsole(blockId);
        state.queue = new Uint8Array(0);
        transport = getSession(blockId)?.transport;
        nextPing = 0;
      } catch {
        // Not open yet — the next tick tries again.
      }
    }
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
      const tail = m[7];
      const circuit = tail.match(/circuit=(\w+) nCB=(\d+)/);
      const machine = tail.match(/state=(\S+)/);
      // The second [INFO] line (build 20260925a and later) names the node:
      // its id, which another board's socket is told to deliver to, and
      // its own name. A board without it just times out the short wait.
      let node = null;
      let nodeName = null;
      let board = null;
      try {
        const next = await readLine(state, 400);
        const n = parseNodeLine(next);
        if (n) { node = n.node; nodeName = n.name; board = n.board; }
      } catch {
        /* no second line */
      }
      return {
        node,
        nodeName,
        board,
        verified: true,
        kind: m[1] === 'CncMod' ? 'cnc' : 'logic',
        version: m[2],
        build: m[3],
        ap: m[4],
        ip: m[5],
        heap: Number(m[6]),
        circuitActive: circuit ? circuit[1] === 'active' : false,
        blockCount: circuit ? Number(circuit[2]) : 0,
        machineState: machine ? machine[1] : null,
      };
    }
    // The boot banner says the app image is there and starting: from here
    // the wait is for a boot to finish rather than for a board that may
    // have nothing on it at all, which earns far more patience than the
    // caller's own budget — a first boot after a flash formats SPIFFS.
    if (!booting && GRBL_BOOTING_RE.test(line)) {
      booting = true;
      deadline = Math.max(deadline, Date.now() + bootGraceMs);
    }
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
          ? `noditron v${version} is installed but the board keeps resetting${cause}. `
            + 'Check the USB cable and port, or power the board externally.'
          : `The board is resetting in a loop${cause} and cannot answer. `
            + 'Check power first; if it holds up, re-install the firmware — what is on it may not be noditron.',
      );
    }
    if (NO_APP_RE.test(line)) break;
  }
  closeConsole(blockId);
  return { verified: false, booting };
}

// Over WiFi the design goes by HTTP: `save-design`'s raw byte phase is a
// serial thing, and the board serves and takes design.json directly (the
// same two endpoints its own page uses).
async function readDesignOverHttp(session) {
  const res = await fetch(`http://${session.host}/design.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`design.json: HTTP ${res.status}`);
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : { blocks: [] };
}

async function sendDesignOverHttp(session, design) {
  const text = JSON.stringify(design);
  const form = new FormData();
  form.append('design', new Blob([text], { type: 'application/json' }), 'design.json');
  const res = await fetch(`http://${session.host}/save-design`, { method: 'POST', body: form });
  const reply = await res.text().catch(() => '');
  if (!res.ok || !/OK/.test(reply)) throw new Error(`The board did not accept the ${text.length}-byte design: ${res.status} ${reply}`.trim());
  return `[DESIGN] Saved ${text.length} bytes OK`;
}

// `line` is what is asked: `design` for the board on this link, or
// `design <node>` for a node behind it on the bus — that board fetches the
// node's circuit over CAN in parts and prints the whole the same way (see
// conucon's designFromNode), so it is read exactly like its own. Fetching
// takes the board a moment before the first line, and CAN traffic it
// relays meanwhile can come first: lines are skipped until the design
// starts or the board says why it cannot.
async function readDesignCommand(blockId, { timeoutMs = 4000, line = 'design' } = {}) {
  const session = getSession(blockId);
  // The board's own circuit over WiFi is its design.json; a node behind it
  // (`design <node>`) is read like over USB — the board's WebSocket shell
  // answers with the same [DESIGN] BEGIN ... END lines.
  if (session?.kind === 'wifi' && line === 'design') return readDesignOverHttp(session);
  await ensurePlain(blockId);
  const state = openConsole(blockId);
  state.queue = new Uint8Array(0); // see identify()'s own doc on why
  await writeLine(blockId, line);
  const deadline = Date.now() + timeoutMs;
  let m = null;
  while (!m) {
    const begin = await readLine(state, Math.max(1, deadline - Date.now()));
    if (/^error/.test(begin)) throw new Error(begin.replace(/^error:\s*/, ''));
    m = begin.match(/^\[DESIGN] BEGIN (\d+)/);
    if (!m && Date.now() >= deadline) throw new Error(`Unexpected response: ${begin}`);
  }
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
const propOf = (block, name) => (block.props || []).find((p) => p.name === name)?.value;

function collapsePassThroughs(childBlocks, connections) {
  const pinlessBools = new Set(
    childBlocks
      .filter((b) => propOf(b, 'noditronKind') === 'digital-io')
      .filter((b) => {
        const pin = propOf(b, 'pin');
        return pin === null || pin === undefined || pin === '';
      })
      .map((b) => b.id),
  );
  const byId = new Map(childBlocks.map((b) => [b.id, b]));
  const portNameOf = (blockId, portId) => {
    const block = byId.get(blockId);
    const pin = (block?.ports || []).find((p) => p.id === portId);
    return (block?.logicalPorts || []).find((l) => l.id === pin?.logicalId)?.name ?? null;
  };
  const fedThrough = (blockId, name) => connections.some((c) => c.targetBlockId === blockId && portNameOf(blockId, c.targetPortId) === name);
  // Block id -> the input whose value it passes on unchanged.
  const passThrough = new Map([...pinlessBools].map((id) => [id, 'in']));
  // A Data fed through `write` used to be folded into a junction here (the
  // firmware's data block had no write input). Since build 20260928a a
  // data block two or more rows tall takes a belt on a lower row as a
  // write — stored and sent on — so those wires are laid out instead (see
  // the written sinks and writer rows below).
  if (!passThrough.size) return connections;
  const feedsOf = (blockId) => connections.filter((c) => c.targetBlockId === blockId && portNameOf(blockId, c.targetPortId) === passThrough.get(blockId));
  // Every real source a wire leaving `conn`'s source traces back to.
  const sourcesOf = (conn, seen) => {
    if (!passThrough.has(conn.sourceBlockId)) return [conn];
    if (seen.has(conn.sourceBlockId)) return [];
    const next = new Set(seen).add(conn.sourceBlockId);
    return feedsOf(conn.sourceBlockId).flatMap((feed) => sourcesOf(feed, next));
  };
  const out = [];
  const added = new Set();
  for (const conn of connections) {
    if (passThrough.has(conn.targetBlockId)) continue;
    for (const source of sourcesOf(conn, new Set())) {
      if (pinlessBools.has(source.sourceBlockId)) continue; // a Bool fed by nothing: a manual value the board cannot hold
      const key = `${source.sourceBlockId}:${source.sourcePortId}>${conn.targetBlockId}:${conn.targetPortId}`;
      if (added.has(key)) continue;
      added.add(key);
      out.push({ ...conn, sourceBlockId: source.sourceBlockId, sourcePortId: source.sourcePortId });
    }
  }
  return out;
}

// One line for the person who drew it, about one drawn block: kept in
// `notes`, and — when the caller keeps `notes.byBlock` (a Map) — by the
// block's id too, so the block itself can be marked (see leftOutMarks.js).
export function noteBlock(notes, blockId, text) {
  if (!notes) return;
  notes.push(text);
  if (!blockId || !(notes.byBlock instanceof Map)) return;
  const list = notes.byBlock.get(blockId) || [];
  if (!list.includes(text)) list.push(text);
  notes.byBlock.set(blockId, list);
}

// `notes`, when an array is given, collects one line per drawn block the
// board's design leaves out — a wiring shape the layouts below have no
// row for. The design itself stays as it is: what the board runs is what
// this compiles, and the lines are for the person who drew the rest.
export function buildMinimalDesign(childBlocks, connections = [], notes = null) {
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
  // The wires as drawn, for the notes at the end: after the collapse a Data
  // fed through `write` has no wires left, and that is exactly the block
  // worth a word.
  const drawn = connections;
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

  // Preserve a source -> Data.in -> hardware output chain. The firmware's
  // data block owns the stored value and emits it when its input is triggered;
  // collapsing this chain would incorrectly bypass that behavior.
  for (const dataChild of dataChildren) {
    if (idByChildId.has(dataChild.id)) continue;
    // A Data something writes is laid out with its writers (the writer
    // rows below), trigger included — not as this one-row shape.
    if (connections.some((c) => c.targetBlockId === dataChild.id && portName(dataChild, c.targetPortId) === 'write')) continue;
    const inputConn = connections.find((c) => c.targetBlockId === dataChild.id && portName(dataChild, c.targetPortId) === 'in');
    const outputConn = connections.find((c) => c.sourceBlockId === dataChild.id && portName(dataChild, c.sourcePortId) === 'out');
    if (!inputConn || !outputConn) continue;
    const source = pinChildren.find((c) => c.id === inputConn.sourceBlockId) || timerChildren.find((c) => c.id === inputConn.sourceBlockId);
    const target = pinChildren.find((c) => c.id === outputConn.targetBlockId);
    if (!source || !target) continue;
    const sourceDir = propOf(source, 'direction') === 'output' ? 'output' : 'input';
    const targetDir = propOf(target, 'direction') === 'output' ? 'output' : 'input';
    if (sourceDir !== 'input' || targetDir !== 'output') continue;

    const base = row * 3;
    placeSource(source, 0, base);
    const dataId = nextBlockId++;
    idByChildId.set(dataChild.id, dataId);
    blocks.push({
      id: dataId,
      type: 'data',
      gx: 3,
      gy: base,
      data: { value: String(propOf(dataChild, 'value') ?? '') },
    });
    blocks.push({ id: nextBlockId++, type: 'belt', gx: 2, gy: base, data: { dir: 'E' } });
    placeBool(target, 6, base);
    blocks.push({ id: nextBlockId++, type: 'belt', gx: 5, gy: base, data: { dir: 'E' } });
    row += 1;
  }

  // Route gates (conucon's `route`): a Route whose `sel` comes from an
  // Input pin, whose `in` comes from a pin or Timer — through a Match row
  // and/or a Delay (the firmware's `timer` in mode "delay") — and whose
  // outputs end, each through an optional Data, in one Output pin.
  // sel "0" -> out1, "1" -> out2 (firmware out[i] = noditron out(i+1),
  // the order Route's own fn counts in); an unwired output drops the value.
  // Layout per Route (T = row*3, C = T+hm+1, E = C+2, A = E+matchRow):
  //   T     sel pin @ (0,T) -> belt (2,T) -> croute @ (3,T) -> rows -> Data @ (6,.) -> sink @ (9,T)
  //   T+1.. belt (2,.) S down the pin's right face, then E along row C -> route sel cell @ (9,C)
  //   E     source @ (0,E) -> belt (2,E) -> croute @ (3,E) -> row A -> belt (5,A)
  //         -> delay @ (6,A) -> belt (8,A) -> route channel @ (9,A)
  //   C+1+i route out i @ (10,.) -> Data @ (11,.) -> belt (13,.) -> sink @ (14,.)
  const routeChildren = childBlocks.filter((c) => propOf(c, 'noditronKind') === 'route');
  const delayChildren = childBlocks.filter((c) => propOf(c, 'noditronKind') === 'delay');
  const crouteKids = childBlocks.filter((c) => propOf(c, 'noditronKind') === 'croute');
  const childById = (id) => childBlocks.find((c) => c.id === id) || null;
  const feedOf = (block, name) => connections.find((c) => c.targetBlockId === block.id && portName(block, c.targetPortId) === name) || null;
  const isOutputPin = (c) => Boolean(c) && pinChildren.includes(c) && propOf(c, 'direction') === 'output';
  const isInputPin = (c) => Boolean(c) && pinChildren.includes(c) && propOf(c, 'direction') !== 'output';
  const repeatable = (c) => propOf(c, 'repeatable') === true;
  const outIndexOf = (block, portId) => (block.ports || [])
    .map((pin) => (block.logicalPorts || []).find((lp) => lp.id === pin.logicalId))
    .filter((lp) => lp?.name && lp.direction === 'out')
    .map((lp) => lp.name)
    .indexOf(portName(block, portId));
  const routesOf = (croute) => {
    let routes = [];
    try { routes = JSON.parse(propOf(croute, 'routes') || '[]'); } catch { routes = []; }
    return (Array.isArray(routes) ? routes : []).map((m) => (m === null || m === undefined ? '' : String(m)));
  };
  const pinBlockAt = (child, gx, gy, size = {}) => {
    if (!idByChildId.has(child.id)) {
      const id = placeBool(child, gx, gy);
      Object.assign(blocks.find((b) => b.id === id), size);
      return true;
    }
    if (!repeatable(child) && !isOutputPin(child)) return false;
    const before = idByChildId.get(child.id);
    idByChildId.delete(child.id);
    const id = placeBool(child, gx, gy);
    Object.assign(blocks.find((b) => b.id === id), size);
    idByChildId.set(child.id, before);
    return true;
  };
  const rowsTo = (block) => {
    const rows = [];
    let sink = null;
    for (const conn of connections.filter((c) => c.sourceBlockId === block.id)) {
      const index = outIndexOf(block, conn.sourcePortId);
      if (index < 0) return null;
      let data = null;
      let end = conn;
      const next = childById(conn.targetBlockId);
      if (next && dataChildren.includes(next) && portName(next, conn.targetPortId) === 'in') {
        data = next;
        end = connections.find((c) => c.sourceBlockId === next.id && portName(next, c.sourcePortId) === 'out');
        if (!end) return null;
      }
      const target = childById(end.targetBlockId);
      if (!isOutputPin(target) || (sink && sink !== target) || rows.some((r) => r.index === index)) return null;
      sink = target;
      rows.push({ index, data });
    }
    if (!rows.length) return null;
    rows.sort((a, b) => a.index - b.index);
    return { rows: rows.some((r) => r.data) ? rows.filter((r) => r.data) : rows, all: rows, sink };
  };
  const dataRow = (gx, gy, data) => {
    blocks.push({ id: nextBlockId++, type: 'belt', gx, gy, data: { dir: 'E' } });
    if (data) {
      const dataId = nextBlockId++;
      idByChildId.set(data.id, dataId);
      blocks.push({ id: dataId, type: 'data', gx: gx + 1, gy, w: 2, h: 1, data: { value: String(propOf(data, 'value') ?? '') } });
    } else {
      blocks.push({ id: nextBlockId++, type: 'belt', gx: gx + 1, gy, data: { dir: 'E' } });
      blocks.push({ id: nextBlockId++, type: 'belt', gx: gx + 2, gy, data: { dir: 'E' } });
    }
    blocks.push({ id: nextBlockId++, type: 'belt', gx: gx + 3, gy, data: { dir: 'E' } });
  };
  for (const route of routeChildren) {
    const name = route.name || 'Route';
    const selConn = feedOf(route, 'sel');
    const sel = selConn && childById(selConn.sourceBlockId);
    if (!isInputPin(sel) || idByChildId.has(sel.id)) {
      noteBlock(notes, route.id, `${name} is left out: its sel needs an Input pin of its own (one the board has not already used elsewhere).`);
      continue;
    }
    let conn = feedOf(route, 'in');
    let delay = null;
    let match = null;
    let matchRow = 0;
    let src = conn && childById(conn.sourceBlockId);
    if (src && delayChildren.includes(src) && !idByChildId.has(src.id)) {
      delay = src; conn = feedOf(delay, 'in'); src = conn && childById(conn.sourceBlockId);
    }
    if (src && crouteKids.includes(src) && !idByChildId.has(src.id)) {
      match = src; matchRow = outIndexOf(match, conn.sourcePortId); conn = feedOf(match, 'in'); src = conn && childById(conn.sourceBlockId);
    }
    const srcOk = src && ((isInputPin(src) && (!idByChildId.has(src.id) || repeatable(src))) || (timerChildren.includes(src) && !idByChildId.has(src.id)));
    if (!srcOk || matchRow < 0 || (match && connections.some((c) => c.sourceBlockId === match.id && c.targetBlockId !== (delay || route).id))) {
      notes?.push(`${name} is left out: its in needs an Input pin, CAN or a Timer — straight, through one Match row, through a Delay, or both.`);
      continue;
    }
    const outs = rowsTo(route);
    if (!outs) {
      notes?.push(`${name} is left out: each output it uses goes (through a Data, if any) to one and the same Output pin.`);
      continue;
    }
    if (outs.rows.length < outs.all.length) notes?.push(`${name}: an output wired straight to the pin beside one through a Data is not on the board; only the Data rows are.`);
    const own = crouteKids.find((c) => c !== match && !idByChildId.has(c.id) && feedOf(c, 'in')?.sourceBlockId === sel.id) || null;
    const ownRows = own && rowsTo(own);

    const T = row * 3;
    placeBool(sel, 0, T);
    let hm = 0;
    if (own && ownRows) {
      const routes = routesOf(own);
      hm = Math.max(2, routes.length, ...ownRows.all.map((r) => r.index + 1));
      blocks.push({ id: nextBlockId++, type: 'belt', gx: 2, gy: T, data: { dir: 'E' } });
      const ownId = nextBlockId++;
      idByChildId.set(own.id, ownId);
      blocks.push({ id: ownId, type: 'croute', gx: 3, gy: T, w: 2, h: hm, data: { routes } });
      for (const { index, data } of ownRows.rows) dataRow(5, T + index, data);
      pinBlockAt(ownRows.sink, 9, T, { w: 2, h: hm });
    } else if (own) {
      notes?.push(`${own.name || 'Match'} (croute) on ${name}'s sel pin is left out: its rows go (through a Data, if any) to one and the same Output pin.`);
    }
    const C = T + hm + 1;
    for (let y = T + 1; y < C; y += 1) blocks.push({ id: nextBlockId++, type: 'belt', gx: 2, gy: y, data: { dir: 'S' } });
    for (let x = 2; x <= 8; x += 1) blocks.push({ id: nextBlockId++, type: 'belt', gx: x, gy: C, data: { dir: 'E' } });
    const E = C + 2;
    const A = E + matchRow;
    if (isInputPin(src)) pinBlockAt(src, 0, E);
    else placeTimer(src, 0, E);
    let hM = 0;
    if (match) {
      const routes = routesOf(match);
      hM = Math.max(1, routes.length, matchRow + 1);
      blocks.push({ id: nextBlockId++, type: 'belt', gx: 2, gy: E, data: { dir: 'E' } });
      const matchId = nextBlockId++;
      idByChildId.set(match.id, matchId);
      blocks.push({ id: matchId, type: 'croute', gx: 3, gy: E, w: 2, h: hM, data: { routes } });
    } else {
      for (let x = 2; x <= 4; x += 1) blocks.push({ id: nextBlockId++, type: 'belt', gx: x, gy: A, data: { dir: 'E' } });
    }
    blocks.push({ id: nextBlockId++, type: 'belt', gx: 5, gy: A, data: { dir: 'E' } });
    if (delay) {
      const delayId = nextBlockId++;
      idByChildId.set(delay.id, delayId);
      const ms = Math.max(1, Math.round(Number(propOf(delay, 'ms')) || 100));
      blocks.push({ id: delayId, type: 'timer', gx: 6, gy: A, w: 2, h: 2, data: { onTime: ms, offTime: 0, mode: 'delay' } });
    } else {
      blocks.push({ id: nextBlockId++, type: 'belt', gx: 6, gy: A, data: { dir: 'E' } });
      blocks.push({ id: nextBlockId++, type: 'belt', gx: 7, gy: A, data: { dir: 'E' } });
    }
    blocks.push({ id: nextBlockId++, type: 'belt', gx: 8, gy: A, data: { dir: 'E' } });
    const maxOut = Math.max(...outs.all.map((r) => r.index));
    const h = Math.max(3, A - C + 1, maxOut + 2);
    const routeId = nextBlockId++;
    idByChildId.set(route.id, routeId);
    blocks.push({ id: routeId, type: 'route', gx: 9, gy: C, w: 1, h, data: {} });
    for (const { index, data } of outs.rows) dataRow(10, C + 1 + index, data);
    const first = C + 1 + outs.rows[0].index;
    const last = C + 1 + outs.rows[outs.rows.length - 1].index;
    pinBlockAt(outs.sink, 14, first, { w: 2, h: Math.max(2, last - first + 1) });
    const bottom = Math.max(E + 1, A + (delay ? 1 : 0), E + hM - 1, C + h - 1, first + Math.max(2, last - first + 1) - 1);
    row = Math.ceil((bottom + 2) / 3);
  }

  // Match (conucon's `croute`) chains, laid out the way conucon's own Logic
  // Module GUI lays out its CAN designs (see esp32_logic/data/design.json):
  //   source @ (0,r) → belt (2,r) → croute @ (3,r), one row per route
  //   route row i → belt (5,r+i) → data @ (6,r+i) 2x1 → belt (8,r+i)
  //                (no Data between: belts (5..8,r+i) straight through)
  //   → one sink @ (9, first row), tall enough to span every row into it.
  // The firmware delivers a belt arriving anywhere inside a block's box to
  // its input, so one tall CAN/DO block takes every chain at once. A
  // croute sends out of row i at (gx+bw, gy+i), so each Data sits on its
  // own route's row, one row high so neighbouring rows never overlap.
  const crouteChildren = childBlocks.filter((c) => propOf(c, 'noditronKind') === 'croute');
  const outputIndex = (block, portId) => {
    const outs = (block.ports || [])
      .map((pin) => (block.logicalPorts || []).find((lp) => lp.id === pin.logicalId))
      .filter((lp) => lp?.name && lp.direction === 'out')
      .map((lp) => lp.name);
    return outs.indexOf(portName(block, portId));
  };
  const chainsByTarget = new Map(); // target pin block -> [{ source, croute, rows: [{ index, data }] }]
  for (const croute of crouteChildren) {
    if (idByChildId.has(croute.id)) continue; // laid out with a Route section above
    const inConn = connections.find((c) => c.targetBlockId === croute.id && portName(croute, c.targetPortId) === 'in');
    const source = inConn && childBlocks.find((c) => c.id === inConn.sourceBlockId);
    if (!source || !(pinChildren.includes(source) || timerChildren.includes(source))) continue;
    if (pinChildren.includes(source) && propOf(source, 'direction') === 'output') continue;
    for (const outConn of connections.filter((c) => c.sourceBlockId === croute.id)) {
      const index = outputIndex(croute, outConn.sourcePortId);
      if (index < 0) continue;
      let data = null;
      let targetConn = outConn;
      const next = dataChildren.find((c) => c.id === outConn.targetBlockId);
      if (next && portName(next, outConn.targetPortId) === 'in') {
        data = next;
        targetConn = connections.find((c) => c.sourceBlockId === next.id && portName(next, c.sourcePortId) === 'out');
        if (!targetConn) continue;
      }
      // The row ends in an Output pin — or in a Data written through its
      // `write` port (a collector), placed as the chain's sink: a data
      // block whose lower rows the chain lands on (see writtenSink below).
      let target = pinChildren.find((c) => c.id === targetConn.targetBlockId);
      if (target && propOf(target, 'direction') !== 'output') continue;
      if (!target) {
        const written = dataChildren.find((c) => c.id === targetConn.targetBlockId);
        if (!written || portName(written, targetConn.targetPortId) !== 'write') continue;
        target = written;
      }
      if (!chainsByTarget.has(target)) chainsByTarget.set(target, []);
      const chains = chainsByTarget.get(target);
      let chain = chains.find((ch) => ch.croute === croute);
      if (!chain) chains.push((chain = { source, croute, rows: [] }));
      // One row per route: a second Data on the same route would need the
      // same grid cell. A second wire from the same route (the bench had
      // Match.1 into Data "unlock"'s in and into its write) is said, not
      // silently dropped.
      if (!chain.rows.some((r) => r.index === index)) chain.rows.push({ index, data });
      else notes?.push(`A second wire from ${croute.name || 'Match'}.${portName(croute, outConn.sourcePortId)} into ${(data || target).name || 'a block'} is not on the board: one row per route, and the first wire has it.`);
    }
  }
  // A written Data sink: its top row is the trigger row and stays clear,
  // the chain rows land on the rows below it (the write rows), and its
  // own out goes on to whatever it drives — an Output pin, to the right.
  const writtenOut = (written) => {
    const conn = connections.find((c) => c.sourceBlockId === written.id && portName(written, c.sourcePortId) === 'out');
    const sink = conn && pinChildren.find((c) => c.id === conn.targetBlockId);
    return sink && propOf(sink, 'direction') === 'output' && !idByChildId.has(sink.id) ? sink : null;
  };
  for (const [target, chains] of chainsByTarget) {
    if (idByChildId.has(target.id)) {
      // A Data that already has its row — triggered in a chain above —
      // and is written from a route as well: the write has no row.
      if (dataChildren.includes(target)) notes?.push(`${[...new Set(chains.map((c) => c.croute.name || 'Match'))].join(', ')} also writes ${target.name || 'Data'}; that wire is not on the board, the block already has its row (triggered there).`);
      continue;
    }
    const writtenSink = dataChildren.includes(target);
    // One row lower for a written sink, so its trigger row (the row above
    // the chain) is a row of its own and never the row before this shape.
    const top = row * 3 + (writtenSink ? 1 : 0);
    let y = top;
    for (const { source, croute, rows } of chains) {
      let routes = [];
      try { routes = JSON.parse(propOf(croute, 'routes') || '[]'); } catch { routes = []; }
      if (!Array.isArray(routes)) routes = [];
      const height = Math.max(2, routes.length, ...rows.map((r) => r.index + 1));
      // A data block fires every belt along its edges that leads away from
      // it, so a straight-through row's belts beside a Data row would carry
      // that Data's value too. Such a mix keeps only its Data rows.
      const kept = rows.some((r) => r.data) ? rows.filter((r) => r.data) : rows;
      if (!idByChildId.has(source.id)) {
        if (pinChildren.includes(source)) placeBool(source, 0, y);
        else placeTimer(source, 0, y);
      }
      blocks.push({ id: nextBlockId++, type: 'belt', gx: 2, gy: y, data: { dir: 'E' } });
      const crouteId = nextBlockId++;
      idByChildId.set(croute.id, crouteId);
      blocks.push({ id: crouteId, type: 'croute', gx: 3, gy: y, w: 2, h: height, data: { routes: routes.map((m) => (m === null || m === undefined ? '' : String(m))) } });
      for (const { index, data } of kept) {
        const gy = y + index;
        blocks.push({ id: nextBlockId++, type: 'belt', gx: 5, gy, data: { dir: 'E' } });
        if (data) {
          const dataId = nextBlockId++;
          idByChildId.set(data.id, dataId);
          blocks.push({ id: dataId, type: 'data', gx: 6, gy, w: 2, h: 1, data: { value: String(propOf(data, 'value') ?? '') } });
        } else {
          blocks.push({ id: nextBlockId++, type: 'belt', gx: 6, gy, data: { dir: 'E' } });
          blocks.push({ id: nextBlockId++, type: 'belt', gx: 7, gy, data: { dir: 'E' } });
        }
        blocks.push({ id: nextBlockId++, type: 'belt', gx: 8, gy, data: { dir: 'E' } });
      }
      y += height + 1;
    }
    if (writtenSink) {
      const dataId = nextBlockId++;
      idByChildId.set(target.id, dataId);
      blocks.push({ id: dataId, type: 'data', gx: 9, gy: top - 1, w: 2, h: y - top, data: { value: String(propOf(target, 'value') ?? '') } });
      const onward = writtenOut(target);
      if (onward) {
        blocks.push({ id: nextBlockId++, type: 'belt', gx: 11, gy: top - 1, data: { dir: 'E' } });
        placeBool(onward, 12, top - 1);
      }
    } else {
      const sinkId = placeBool(target, 9, top);
      const sink = blocks.find((b) => b.id === sinkId);
      sink.w = 2;
      sink.h = y - 1 - top;
    }
    row = Math.ceil(y / 3);
  }

  // Writer rows: a Data written by a source the board can run (an Input
  // pin, a Timer, or a Data such a source triggers), its out driving an
  // Output pin. The written Data is two or more rows tall — the top row
  // for its trigger (a source wired into `in`, when there is one), one
  // row per writer below it:
  //   trigger @ (0,b)      → belts (2..5,b)                 → data @ (6,b), top row
  //   writer k @ (0,r_k)   → belt (2,r_k) [→ data @ (3,r_k) → belt (5,r_k)] → row r_k
  //   data out (8,b) → belt → sink @ (9,b)
  // Sources are two rows tall and fire every belt along their edges, so
  // the writers sit two rows apart (r_k = b + 2 + 2k with a trigger, b +
  // 1 + 2k without) and the written Data spans down to the last writer's
  // row — every row below its top is a write row, so that is fine.
  for (const written of dataChildren) {
    if (idByChildId.has(written.id)) continue;
    const writes = connections.filter((c) => c.targetBlockId === written.id && portName(written, c.targetPortId) === 'write');
    if (!writes.length) continue;
    const sourceOf = (blockId) => childBlocks.find((c) => c.id === blockId) || null;
    const canRun = (c) => Boolean(c) && !idByChildId.has(c.id) && ((pinChildren.includes(c) && propOf(c, 'direction') !== 'output') || timerChildren.includes(c));
    // Each writer as { source, via }: the source that fires the row, and
    // the Data it fires through, if any.
    const writers = [];
    for (const w of writes) {
      const src = sourceOf(w.sourceBlockId);
      if (canRun(src)) { if (!writers.some((x) => x.source === src)) writers.push({ source: src, via: null }); continue; }
      if (src && dataChildren.includes(src) && !idByChildId.has(src.id)) {
        const trig = connections.find((c) => c.targetBlockId === src.id && portName(src, c.targetPortId) === 'in');
        const ts = trig && sourceOf(trig.sourceBlockId);
        if (canRun(ts) && !writers.some((x) => x.source === ts)) writers.push({ source: ts, via: src });
      }
    }
    if (!writers.length) continue;
    const trigConn = connections.find((c) => c.targetBlockId === written.id && portName(written, c.targetPortId) === 'in');
    const trigger = trigConn && sourceOf(trigConn.sourceBlockId);
    const base = row * 3;
    const belt = (gx, gy, dir = 'E') => blocks.push({ id: nextBlockId++, type: 'belt', gx, gy, data: { dir } });
    const hasTrigger = canRun(trigger) && !writers.some((x) => x.source === trigger);
    if (hasTrigger) {
      placeSource(trigger, 0, base);
      for (let gx = 2; gx <= 5; gx += 1) belt(gx, base);
    }
    const firstWriterRow = base + (hasTrigger ? 2 : 1);
    writers.forEach(({ source, via }, k) => {
      const gy = firstWriterRow + 2 * k;
      placeSource(source, 0, gy);
      belt(2, gy);
      if (via) {
        const viaId = nextBlockId++;
        idByChildId.set(via.id, viaId);
        blocks.push({ id: viaId, type: 'data', gx: 3, gy, w: 2, h: 1, data: { value: String(propOf(via, 'value') ?? '') } });
        belt(5, gy);
      } else {
        for (let gx = 3; gx <= 5; gx += 1) belt(gx, gy);
      }
    });
    const lastWriterRow = firstWriterRow + 2 * (writers.length - 1);
    const dataId = nextBlockId++;
    idByChildId.set(written.id, dataId);
    blocks.push({ id: dataId, type: 'data', gx: 6, gy: base, w: 2, h: lastWriterRow - base + 1, data: { value: String(propOf(written, 'value') ?? '') } });
    const onward = writtenOut(written);
    if (onward) {
      belt(8, base);
      placeBool(onward, 9, base);
    }
    // The last writer's box reaches one row below its belt row.
    row += Math.max(1, Math.ceil((lastWriterRow + 2 - base) / 3));
  }

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

    if (dataSource && connections.some((c) => c.targetBlockId === dataSource.id && portName(dataSource, c.targetPortId) === 'write')) {
      // A Data something writes belongs to the writer rows above; when
      // those had no source the board can run, the notes say so, rather
      // than this shape sending its stored value at boot as if nothing
      // ever wrote it.
      continue;
    }
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
      // A Data whose `in` is fed sends on that trigger: DI1 → Data → USB
      // says its text when DI1 changes, not on a clock of its own. Only a
      // Data nothing feeds gets the resend clock — marked `role` so a
      // load from the device (see designImport.js) can tell that clock
      // from a Timer the user actually drew, since both tick 500/500.
      const trigger = connections.find((c) => c.targetBlockId === source.id && portName(source, c.targetPortId) === 'in');
      const triggerSource = trigger && childBlocks.find((c) => c.id === trigger.sourceBlockId);
      if (triggerSource) {
        // Its trigger already placed in another row, or not something the
        // board can run: this simple layout cannot reach it (see the
        // fan-out note above), and a clock instead would send unasked.
        if (!placeSource(triggerSource, 0, base)) continue;
      } else {
        blocks.push({ id: nextBlockId++, type: 'timer', gx: 0, gy: base, data: { onTime: USB_RESEND_MS, offTime: USB_RESEND_MS, mode: 'periodic', role: 'usb-resend' } });
      }
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

  if (notes) {
    // What was drawn but is not in the design above, with the one shape
    // that has cost real time named. A Data with anything wired into its
    // `write` port is a plain junction to the board (collapsePassThroughs:
    // what is written passes to `out`), so a stored value it holds is
    // never sent — Match → Data "unlock" with the route also on `write`
    // sent the route's own value to CAN instead of "unlock". A collector
    // holding nothing loses nothing and gets no note.
    const kindOfChild = (c) => (c.props || []).find((p) => p.name === 'noditronKind')?.value;
    const valueOf = (c) => (c.props || []).find((p) => p.name === 'value')?.value;
    const label = (c) => (kindOfChild(c) === 'data' ? `Data ${JSON.stringify(String(valueOf(c) ?? ''))}` : `${c.name || kindOfChild(c)}`);
    const writtenTo = new Set(drawn.filter((c) => {
      const target = dataChildren.find((d) => d.id === c.targetBlockId);
      return target && portName(target, c.targetPortId) === 'write';
    }).map((c) => c.targetBlockId));
    for (const child of childBlocks) {
      const kind = kindOfChild(child);
      if (!['data', 'timer', 'and', 'croute', 'route', 'delay'].includes(kind) || idByChildId.has(child.id)) continue;
      const wired = drawn.some((c) => c.sourceBlockId === child.id || c.targetBlockId === child.id);
      if (!wired) continue; // an unwired block drives nothing; nothing to say
      if (kind === 'data' && writtenTo.has(child.id)) {
        // Who writes it, by name and port, so the wire in question is named.
        const writers = drawn
          .filter((c) => c.targetBlockId === child.id && portName(child, c.targetPortId) === 'write')
          .map((c) => { const src = childBlocks.find((b) => b.id === c.sourceBlockId); return src ? `${src.name || kindOfChild(src)}.${portName(src, c.sourcePortId) || 'out'}` : 'a wire'; });
        noteBlock(notes, child.id, `${label(child)} is written by ${writers.join(' and ')} in a shape the board has no layout for and was left out (a Data is written at the end of a Match chain, or by an Input pin, a Timer, or a Data one of those triggers).`);
      } else {
        noteBlock(notes, child.id, `${label(child)} (${kind}) is wired in a shape the board has no layout for and was left out.`);
      }
    }
  }

  return { blocks, nextId: nextBlockId };
}

// The circuit as drawn, for a board whose firmware runs wires (build
// WIRED_BUILD and later, see conucon's CWire): one firmware block per
// drawn block, one wire per drawn wire, [from id, output, to id, input].
// No layouts to fit, so every shape the blocks below can make runs —
// fan-out, fan-in, a Gate's sel from an OR, a pin used twice. Each block
// carries `ref` (the drawn block's id, for the board's trace to be shown
// on it) and `at` (where it was drawn, for a load from the device); the
// firmware ignores both. `notes` collects what has no firmware block.
//
// Ports count the way the firmware counts them: outputs in the block's
// own order (a Match's or Gate's out1 is 0); inputs: a Data's write is 1,
// a Gate's sel 0 and its in 1, an AND's or OR's b 1, anything else 0.
export function buildWiredDesign(childBlocks, connections = [], notes = null) {
  const drawn = connections;
  connections = collapsePassThroughs(childBlocks, connections);
  const kindOfChild = (c) => propOf(c, 'noditronKind');
  const byId = new Map(childBlocks.map((c) => [c.id, c]));
  const portOf = (block, portId) => {
    const pin = (block.ports || []).find((p) => p.id === portId);
    return (pin && (block.logicalPorts || []).find((l) => l.id === pin.logicalId)) || null;
  };
  const outputsOf = (block) => (block.logicalPorts || []).filter((l) => l.direction === 'out');
  const hasPin = (c) => { const pin = propOf(c, 'pin'); return pin !== null && pin !== undefined && pin !== ''; };
  const outIndex = (block, lp) => (['croute', 'route'].includes(kindOfChild(block)) ? Math.max(0, outputsOf(block).indexOf(lp)) : 0);
  const inIndex = (block, lp) => {
    const kind = kindOfChild(block);
    if (kind === 'data') return lp.name === 'write' ? 1 : 0;
    if (kind === 'route') return lp.name === 'sel' ? 0 : 1;
    if (kind === 'and' || kind === 'or') return lp.name === 'b' ? 1 : 0;
    return 0;
  };

  const blocks = [];
  const wires = [];
  const seenWire = new Set();
  let nextId = 1;
  const idOf = new Map(); // drawn block id -> firmware id

  function firmwareBlockFor(child) {
    const kind = kindOfChild(child);
    if (kind === 'digital-io') {
      if (!hasPin(child)) return null;
      const pin = Number(propOf(child, 'pin'));
      if (propOf(child, 'direction') === 'output') {
        const exio = Number(propOf(child, 'exio'));
        return { type: 'dout', data: exio >= 1 && exio <= 8 ? { exio } : { gpio: pin } };
      }
      return { type: 'din', data: { gpio: pin, emitOnChange: true } };
    }
    if (kind === 'data') return { type: 'data', data: { value: String(propOf(child, 'value') ?? '') } };
    if (kind === 'timer') {
      // T_ON / T_OFF exactly as placeTimer reads them.
      const kids = child.children ? Array.from(child.children.blocks.values()) : [];
      const onTime = Number(kids.find((k) => k.name === 'T_ON')?.props?.find((p) => p.name === 'value')?.value) || 500;
      const offTime = Number(kids.find((k) => k.name === 'T_OFF')?.props?.find((p) => p.name === 'value')?.value) || 500;
      return { type: 'timer', data: { onTime, offTime, mode: 'periodic' } };
    }
    if (kind === 'delay') return { type: 'timer', data: { onTime: Math.max(1, Math.round(Number(propOf(child, 'ms')) || 100)), offTime: 0, mode: 'delay' } };
    if (kind === 'croute') {
      let routes = [];
      try { routes = JSON.parse(propOf(child, 'routes') || '[]'); } catch { routes = []; }
      if (!Array.isArray(routes)) routes = [];
      routes = routes.map((m) => (m === null || m === undefined ? '' : String(m)));
      return { type: 'croute', h: Math.max(1, routes.length), data: { routes } };
    }
    // A Gate's rows: its sel, then one per output (the firmware's bh - 1).
    if (kind === 'route') return { type: 'route', w: 1, h: 1 + Math.max(1, outputsOf(child).length), data: {} };
    if (kind === 'and' || kind === 'or' || kind === 'not') return { type: kind, data: {} };
    if (kind === 'usb-serial') return { type: 'serial', data: { uart: 0, baud: 115200, prefix: USB_SERIAL_PREFIX } };
    return null;
  }

  function place(child) {
    if (idOf.has(child.id)) return idOf.get(child.id);
    const fw = firmwareBlockFor(child);
    if (!fw) { idOf.set(child.id, null); return null; }
    const id = nextId++;
    const block = { id, type: fw.type, ...(fw.w ? { w: fw.w } : {}), ...(fw.h ? { h: fw.h } : {}), data: fw.data };
    // A drawn block (not a board pin the compiler stands in for) says
    // which one it is and where it sits.
    if (child.geometry) {
      block.ref = child.id;
      block.at = [Math.round(Number(child.geometry.x) || 0), Math.round(Number(child.geometry.y) || 0)];
    }
    blocks.push(block);
    idOf.set(child.id, id);
    return id;
  }
  function wire(s, sp, d, dp) {
    const k = `${s}:${sp}>${d}:${dp}`;
    if (seenWire.has(k)) return;
    seenWire.add(k);
    wires.push([s, sp, d, dp]);
  }

  for (const conn of connections) {
    const src = byId.get(conn.sourceBlockId);
    const dst = byId.get(conn.targetBlockId);
    if (!src || !dst) continue;
    const sp = portOf(src, conn.sourcePortId);
    const dp = portOf(dst, conn.targetPortId);
    if (!sp || !dp) continue;
    const s = place(src);
    const d = place(dst);
    if (s === null || d === null) continue;
    wire(s, outIndex(src, sp), d, inIndex(dst, dp));
  }
  // Every pin declared, wired or not, so the board reports it (see
  // buildMinimalDesign's unconnected-pins pass).
  for (const child of childBlocks) if (kindOfChild(child) === 'digital-io' && hasPin(child)) place(child);

  // A Data nothing triggers or writes sends only when something asks, and
  // nothing will: the board wakes it once at boot, or — feeding USB — every
  // USB_RESEND_MS so a browser that connects later still hears it. The
  // helpers carry the same marks the grid layouts give them (see
  // designImport's `dropped`), so a load from the device leaves them out.
  const USB_RESEND_MS = 500;
  for (const child of childBlocks) {
    if (kindOfChild(child) !== 'data' || !idOf.get(child.id)) continue;
    const dataId = idOf.get(child.id);
    if (wires.some((w) => w[2] === dataId)) continue;
    const feeds = wires.filter((w) => w[0] === dataId);
    if (!feeds.length) continue;
    const toUsb = feeds.some((w) => blocks.find((b) => b.id === w[2])?.type === 'serial');
    const trigger = toUsb
      ? { id: nextId++, type: 'timer', data: { onTime: USB_RESEND_MS, offTime: USB_RESEND_MS, mode: 'periodic', role: 'usb-resend' } }
      : { id: nextId++, type: 'boot', data: { delay: 100 } };
    blocks.push(trigger);
    wire(trigger.id, 0, dataId, 0);
  }

  if (notes) {
    const label = (c) => (kindOfChild(c) === 'data' ? `Data ${JSON.stringify(String(propOf(c, 'value') ?? ''))}` : `${c.name || kindOfChild(c)}`);
    for (const child of childBlocks) {
      if (idOf.get(child.id)) continue;
      const kind = kindOfChild(child);
      if (kind === 'led') continue; // shown by the page from the board's own values
      const out = drawn.some((c) => c.sourceBlockId === child.id);
      const into = drawn.some((c) => c.targetBlockId === child.id);
      if (!out && !into) continue;
      if (kind === 'digital-io' && !hasPin(child)) {
        if (!into) noteBlock(notes, child.id, `${label(child)} has no pin: a value set on screen, which the board cannot hold. Its wires are left out.`);
        continue;
      }
      noteBlock(notes, child.id, `${label(child)} (${kind}) has no block on the board and was left out.`);
    }
    // Not left out, but almost never meant: one output into a Data's `in`
    // and its `write` both. The trigger sends the text, then the write
    // stores what arrived ("1") and sends that — and every later trigger
    // sends "1" too.
    for (const child of childBlocks) {
      if (kindOfChild(child) !== 'data') continue;
      const feedsOf = (name) => drawn.filter((c) => c.targetBlockId === child.id && portOf(child, c.targetPortId)?.name === name).map((c) => `${c.sourceBlockId}:${c.sourcePortId}`);
      const writes = new Set(feedsOf('write'));
      const both = feedsOf('in').find((k) => writes.has(k));
      if (!both) continue;
      const [srcId, srcPort] = both.split(':');
      const src = byId.get(srcId);
      const name = src ? `${src.name || kindOfChild(src)}.${portOf(src, srcPort)?.name || 'out'}` : 'one output';
      noteBlock(notes, child.id, `${label(child)} has a second wire from ${name}, into its write port. Each press then overwrites the text with "1" — so it sends ${JSON.stringify(String(propOf(child, 'value') ?? ''))} once and "1" after that. Only the wire into in is needed.`);
    }
  }

  return { format: 'wires', blocks, wires, nextId };
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

// The ESP32-S3's native USB console (HWCDC) queues only 256 received bytes
// and silently drops whatever arrives while that queue is full. A design
// written in one go overruns it: the firmware keeps waiting for bytes that
// never come, swallowing every later command (ping included) as payload, so
// the board looks dead. Paced chunks stay well inside that queue.
const DESIGN_CHUNK_BYTES = 64;
const DESIGN_CHUNK_GAP_MS = 25;

// Unsolicited log lines (io broadcasts, driver messages) can arrive before a
// reply, so skip until one matches — never treat the first line as the answer.
async function readReply(state, pattern, failure, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = await readLine(state, Math.max(1, deadline - Date.now()));
    if (pattern.test(line)) return line;
    if (failure.test(line)) throw new Error(line);
  }
}

// `target`: a node behind this board on the bus. The board takes the bytes
// the same way (`save-design <node> <n>`), then writes them to that node
// over CAN in parts (conucon's designToNode) before it confirms — a few
// seconds for a large circuit, so its confirmation is waited for longer.
async function sendDesignCommand(blockId, design, { timeoutMs = 5000, target = null } = {}) {
  const session = getSession(blockId);
  if (session?.kind === 'wifi') {
    if (target) return sendDesignInParts(blockId, target, design);
    return sendDesignOverHttp(session, design);
  }
  await ensurePlain(blockId);
  const state = openConsole(blockId);
  state.queue = new Uint8Array(0); // see identify()'s own doc on why
  const bytes = new TextEncoder().encode(JSON.stringify(design));
  await writeLine(blockId, target ? `save-design ${target} ${bytes.length}` : `save-design ${bytes.length}`);
  await readReply(state, /\[DESIGN] READY/, /\[DESIGN] SAVE_FAILED|^error/, timeoutMs);
  for (let i = 0; i < bytes.length; i += DESIGN_CHUNK_BYTES) {
    if (i) await new Promise((resolve) => setTimeout(resolve, DESIGN_CHUNK_GAP_MS));
    await writeBytes(blockId, bytes.slice(i, i + DESIGN_CHUNK_BYTES));
  }
  try {
    return await readReply(state, /\[DESIGN] Saved \d+ bytes OK/, /\[DESIGN] (SAVE_FAILED|SPIFFS write failed)|^error/, target ? Math.max(timeoutMs, 30000) : timeoutMs);
  } catch (err) {
    if (!/Timed out waiting for the device/.test(err.message)) throw err;
    throw new Error(`The board did not confirm the ${bytes.length}-byte design. Reset the board, reconnect and save again.`);
  }
}

// A node behind a board on WiFi: the raw byte phase of `save-design <node>
// <n>` is a serial thing, so the circuit goes the way that board would
// send it on over CAN itself — `save-design part <i> <n> <size> <base64>`
// lines (conucon's saveDesignPart), each run on the node through the
// board's shell (`node <target> ...`) and answered before the next. The
// node writes the last part and reloads its circuit. Runs inside the
// bridge's command queue, so it calls shellCommand, not shell().
export const DESIGN_PART_BYTES = 120;
export function designParts(design) {
  const bytes = new TextEncoder().encode(JSON.stringify(design));
  const parts = [];
  const count = Math.ceil(bytes.length / DESIGN_PART_BYTES);
  for (let i = 0; i < count; i += 1) {
    let binary = '';
    for (const b of bytes.subarray(i * DESIGN_PART_BYTES, (i + 1) * DESIGN_PART_BYTES)) binary += String.fromCharCode(b);
    parts.push(`save-design part ${i} ${count} ${bytes.length} ${btoa(binary)}`);
  }
  return { parts, size: bytes.length };
}
async function sendDesignInParts(blockId, target, design) {
  const { parts, size } = designParts(design);
  for (const [i, part] of parts.entries()) {
    const reply = await shellCommand(blockId, `node ${target} ${part}`, { timeoutMs: 6000, quiet: true });
    if (!reply.ok) throw new Error(`${target} did not take part ${i + 1}/${parts.length} of its circuit: ${reply.error || 'no reply'}`);
  }
  return `[DESIGN] Saved ${size} bytes OK`;
}

// Every command shares one byte stream. In particular, polling must never
// consume the READY/Saved reply belonging to a circuit upload.
const commandQueues = new Map(); // blockId -> { running, jobs }
// `quiet`: the command is the app's own housekeeping, not something the
// user or a wire said — see lineListeners.
// `urgent` (by default: whatever is not quiet) goes ahead of every waiting
// command that is not, behind the one running and any urgent one before
// it. A jog, a stop or a typed line used to wait out the app's polls (the
// machine's state every 500 ms, pins, trace renewals), and through a
// board relaying over CAN each of those is a round trip on the bus: the
// jog came seconds late.
export function queueCommand(blockId, run, { quiet = false, urgent = !quiet } = {}) {
  let q = commandQueues.get(blockId);
  if (!q) {
    q = { running: false, jobs: [] };
    commandQueues.set(blockId, q);
  }
  return new Promise((resolve, reject) => {
    const job = { run, quiet, urgent, resolve, reject };
    const firstPlain = urgent ? q.jobs.findIndex((j) => !j.urgent) : -1;
    if (firstPlain < 0) q.jobs.push(job);
    else q.jobs.splice(firstPlain, 0, job);
    pumpCommands(blockId, q);
  });
}
async function pumpCommands(blockId, q) {
  if (q.running) return;
  q.running = true;
  while (q.jobs.length) {
    const job = q.jobs.shift();
    activeCommands.set(blockId, (activeCommands.get(blockId) || 0) + 1);
    if (job.quiet) quietCommands.set(blockId, (quietCommands.get(blockId) || 0) + 1);
    try {
      job.resolve(await job.run());
    } catch (err) {
      job.reject(err);
    } finally {
      activeCommands.set(blockId, Math.max(0, (activeCommands.get(blockId) || 1) - 1));
      if (job.quiet) quietCommands.set(blockId, Math.max(0, (quietCommands.get(blockId) || 1) - 1));
    }
  }
  q.running = false;
  if (commandQueues.get(blockId) === q) commandQueues.delete(blockId);
}

// One line to the board's shell, its reply back: every shell command ends
// with `ok` or `error: <why>` (firmware build 20260925a and later), which
// is where this stops reading. Lines the board prints on its own in the
// meantime (a pin change, a CAN frame) come back too, as they would on a
// terminal. A firmware without the terminator answers by timing out with
// whatever it printed.
// Whether `ok <named>` ends `line`: the line itself, or what a node ran of
// `node <to> <line>` (relayed, the far node names its own part). The
// firmware shortens a long one to 45 characters and `...`.
export function okNames(line, named) {
  if (!named) return true;
  const cut = named.endsWith('...') ? named.slice(0, -3) : null;
  const ran = [String(line).trim()];
  for (let m; (m = /^node\s+\S+\s+(.*)$/s.exec(ran[ran.length - 1]));) ran.push(m[1].trim());
  return ran.some((l) => l === named || (cut !== null && l.startsWith(cut)));
}

async function shellCommand(blockId, line, { timeoutMs = 4000, quiet = false, via = null } = {}) {
  void quiet; // read by shell() for the queue; the reply is the same either way
  await ensurePlain(blockId);
  const state = openConsole(blockId);
  state.queue = new Uint8Array(0); // see identify()'s own doc on why
  await writeLine(blockId, line, { via });
  const lines = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let reply;
    try {
      reply = await readLine(state, Math.max(1, deadline - Date.now()));
    } catch {
      break;
    }
    // `ok`, or `ok <the command>` from a board that names what it ended.
    // An ok naming another command is a late answer to an earlier one (it
    // timed out, and its reply came in now): its lines are not this
    // command's, and this one's answer is still to come. Taken as ours, it
    // put every reply after it one command behind.
    if (reply === 'ok' || reply.startsWith('ok ')) {
      if (okNames(line, reply.slice(3))) return { ok: true, lines, end: reply };
      lines.length = 0;
      continue;
    }
    if (reply.startsWith('error:')) return { ok: false, error: reply.slice(6).trim(), lines, end: reply };
    lines.push(reply);
  }
  return { ok: false, error: 'no reply', lines };
}

// A shell line is the user's (or a wire's) unless the caller says
// `quiet` — the dialog's own status polls do. Everything else this file
// sends is housekeeping and always quiet.
// The far board's shell through its bridge (see bridgeFor): the line goes
// as `node <target> <line>`, quietly on the bridge, and what comes back is
// the far board's reply — shown to whoever listens to the far block, as
// its own console would show it, terminator included.
async function bridgedShellCommand(bridge, blockId, line, { timeoutMs = 4500, quiet = false, urgent = !quiet, via = null } = {}) {
  notifyLineListeners(blockId, { line: String(line), outgoing: true, unsolicited: false, quiet, via });
  // Quiet on the bridge (its own console does not show it), but as urgent
  // there as it was asked: a jog relayed waits for no poll of the bridge.
  const reply = await shell(bridge.bridgeId, `node ${bridge.target} ${line}`, { timeoutMs, quiet: true, urgent });
  for (const text of reply.lines || []) notifyLineListeners(blockId, { line: text, unsolicited: false, quiet });
  const tail = reply.end || (reply.ok ? 'ok' : reply.error ? `error: ${reply.error}` : null);
  if (tail) notifyLineListeners(blockId, { line: tail, unsolicited: false, quiet });
  return reply;
}

// The identity in a ping reply's lines (see identifyCommand for the
// same read on a link of the block's own).
function infoFromLines(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = String(lines[i]).match(INFO_RE);
    if (!m) continue;
    const tail = m[7];
    const circuit = tail.match(/circuit=(\w+) nCB=(\d+)/);
    const machine = tail.match(/state=(\S+)/);
    const n = parseNodeLine(lines[i + 1]);
    return {
      node: n ? n.node : null,
      nodeName: n ? n.name : null,
      board: n ? n.board : null,
      verified: true,
      kind: m[1] === 'CncMod' ? 'cnc' : 'logic',
      version: m[2],
      build: m[3],
      ap: m[4],
      ip: m[5],
      heap: Number(m[6]),
      circuitActive: circuit ? circuit[1] === 'active' : false,
      blockCount: circuit ? Number(circuit[2]) : 0,
      machineState: machine ? machine[1] : null,
    };
  }
  return null;
}

async function bridgedIdentify(bridge, blockId) {
  const reply = await bridgedShellCommand(bridge, blockId, 'ping', { timeoutMs: 4500, quiet: true });
  const info = infoFromLines(reply.lines || []);
  return info ? { ...info, via: bridge.bridgeId } : { verified: false, booting: false, via: bridge.bridgeId };
}

export function shell(blockId, line, opts = {}) {
  const bridge = bridgeFor(blockId);
  const order = { quiet: Boolean(opts.quiet), urgent: opts.urgent ?? !opts.quiet };
  if (bridge) return queueCommand(blockId, () => bridgedShellCommand(bridge, blockId, line, { ...opts, urgent: order.urgent }), order);
  return queueCommand(blockId, () => shellCommand(blockId, line, opts), order);
}

export function identify(blockId, ...args) {
  const bridge = bridgeFor(blockId);
  const asked = bridge
    ? queueCommand(blockId, () => bridgedIdentify(bridge, blockId), { quiet: true })
    : queueCommand(blockId, () => identifyCommand(blockId, ...args), { quiet: true });
  return asked.then((info) => {
    if (info?.verified && info.build) noteFirmwareBuild(blockId, info.build);
    return info;
  });
}

// The firmware build each board last said it runs (its `ping`), which
// decides the design format it is sent (see devkitCircuit's
// buildPinMappedDesign): wires from WIRED_BUILD on, belts before. A host
// can keep it on the block too (setBuildRecorder) so a board compiles the
// same way after a reload, before it has been asked again.
export const WIRED_BUILD = '20261011a';
const firmwareBuilds = new Map(); // blockId -> build
let buildRecorder = null;
export function setBuildRecorder(fn) {
  buildRecorder = fn;
}
function noteFirmwareBuild(blockId, build) {
  if (firmwareBuilds.get(blockId) === build) return;
  firmwareBuilds.set(blockId, build);
  buildRecorder?.(blockId, build);
}
export function firmwareBuildOf(blockId) {
  return firmwareBuilds.get(blockId) || null;
}
export function runsWires(build) {
  return Boolean(build) && String(build) >= WIRED_BUILD;
}

// Asks a board for its trace (see subscribeTrace) for the next few seconds;
// called again while its circuit is on screen, never otherwise.
export function traceOn(blockId) {
  return queueCommand(blockId, () => shellCommand(blockId, 'trace on', { timeoutMs: 1500, quiet: true }), { quiet: true });
}
export function traceOff(blockId) {
  return queueCommand(blockId, () => shellCommand(blockId, 'trace off', { timeoutMs: 1500, quiet: true }), { quiet: true });
}

// A board behind another on the bus is read through that one: the bridge's
// link, its queue, `design <node>` (see readDesignCommand). The far board
// sends its circuit in parts of 138 bytes, a few dozen ms each.
export function readDesign(blockId, opts = {}) {
  const bridge = bridgeFor(blockId);
  if (bridge) {
    return queueCommand(bridge.bridgeId, () => readDesignCommand(bridge.bridgeId, { ...opts, timeoutMs: Math.max(opts.timeoutMs || 0, 20000), line: `design ${bridge.target}` }), { quiet: true });
  }
  return queueCommand(blockId, () => readDesignCommand(blockId, opts), { quiet: true });
}

export function setPin(blockId, ...args) {
  return queueCommand(blockId, () => setPinCommand(blockId, ...args), { quiet: true });
}

export function readPins(blockId, ...args) {
  return queueCommand(blockId, () => readPinsCommand(blockId, ...args), { quiet: true });
}

// A board behind another on the bus is saved through that one, on its
// link and queue (see sendDesignCommand's `target`).
export function sendDesign(blockId, design, opts = {}) {
  const bridge = bridgeFor(blockId);
  if (bridge) return queueCommand(bridge.bridgeId, () => sendDesignCommand(bridge.bridgeId, design, { ...opts, target: bridge.target }), { quiet: true });
  return queueCommand(blockId, () => sendDesignCommand(blockId, design, opts), { quiet: true });
}
