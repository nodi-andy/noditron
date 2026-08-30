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
import { getSession, reopenPlain } from './serialFlash.js';

const consoles = new Map(); // blockId -> { queue: Uint8Array, waiters: [] }

// Makes sure the port is actually open in plain mode before any read/write
// here touches it. Three cases: never opened yet (open it plain, straight
// off the port `serialFlash.connect()` already picked); already open and
// plain (an earlier call already did this — leave it alone, re-opening a
// port that's fine as-is would just be an extra, pointless DTR toggle,
// which resets most ESP32 boards); or SLIP-tainted by a bootloader session
// (`session.esploader` set — see serialFlash.js's own note on why that
// can't be undone in place) — force the close/reopen cycle, and throw out
// this blockId's console state since it was reading a transport that just
// got replaced out from under it.
async function ensurePlain(blockId) {
  const session = getSession(blockId);
  if (!session) throw new Error('Not connected — pick a serial port first.');
  if (session.esploader) {
    await reopenPlain(blockId);
    closeConsole(blockId);
  } else if (!session.port.readable) {
    await session.transport.connect(115200);
  }
}

function appendBytes(state, chunk) {
  const merged = new Uint8Array(state.queue.length + chunk.length);
  merged.set(state.queue);
  merged.set(chunk, state.queue.length);
  state.queue = merged;
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
  state = { queue: new Uint8Array(0), waiters: [], closed: false };
  consoles.set(blockId, state);
  session.transport.rawRead((chunk) => appendBytes(state, chunk), () => state.closed).catch(() => {});
  return state;
}

// Cancels a read that's already blocked waiting for the device's first
// byte — rawRead's own isClosed() is only checked *between* chunks (see
// its own doc), so a silent device would otherwise hang this forever
// without an explicit cancel, same reasoning as Transport.disconnect()'s.
export function closeConsole(blockId) {
  const state = consoles.get(blockId);
  if (!state) return;
  state.closed = true;
  consoles.delete(blockId);
  const session = getSession(blockId);
  session?.transport?.reader?.cancel().catch(() => {});
}

async function writeLine(blockId, text) {
  const session = getSession(blockId);
  const writer = session.transport.device.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(`${text}\n`));
  } finally {
    writer.releaseLock();
  }
}

async function writeBytes(blockId, bytes) {
  const session = getSession(blockId);
  const writer = session.transport.device.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

const INFO_RE = /^\[INFO] LogicMod v(\S+) build (\S+) \| AP=(\S+) \| IP=(\S+) \| heap=(\d+) \| circuit=(\w+) nCB=(\d+)/;

// Plain `ping` — the same command a human gets from a serial monitor,
// nothing added just for this. Whatever old boot-log lines are still
// sitting in the queue from before this call are irrelevant noise, not a
// stale answer to *this* ping (nothing here could have asked before now),
// so they're discarded up front rather than risking a match against them.
export async function identify(blockId, { timeoutMs = 3000 } = {}) {
  await ensurePlain(blockId);
  const state = openConsole(blockId);
  state.queue = new Uint8Array(0);
  await writeLine(blockId, 'ping');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let line;
    try {
      line = await readLine(state, Math.max(deadline - Date.now(), 1));
    } catch {
      break;
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
  }
  closeConsole(blockId);
  return { verified: false };
}

export async function readDesign(blockId, { timeoutMs = 4000 } = {}) {
  await ensurePlain(blockId);
  const state = openConsole(blockId);
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

// Deliberately not a general graph compiler — esp32_logic's own circuit
// model is belts on a grid (Factorio-style signal routing), nodigraph's is
// named ports and point-to-point wires between arbitrary blocks; actually
// translating connections between the two is real, separate work. All
// this does is declare the pins themselves: one din/dout per Digital I/O
// child that has a real pin set, laid out on an unconnected row.
export function buildMinimalDesign(childBlocks) {
  const blocks = [];
  let nextBlockId = 1;
  let col = 0;
  for (const child of childBlocks) {
    if ((child.props || []).find((p) => p.name === 'noditronKind')?.value !== 'digital-io') continue;
    const pin = (child.props || []).find((p) => p.name === 'pin')?.value;
    if (pin === null || pin === undefined || pin === '') continue;
    const direction = (child.props || []).find((p) => p.name === 'direction')?.value === 'output' ? 'dout' : 'din';
    blocks.push({ id: nextBlockId, type: direction, gx: col * 3, gy: 0, data: { gpio: Number(pin) } });
    nextBlockId += 1;
    col += 1;
  }
  return { blocks, nextId: nextBlockId };
}

export async function sendDesign(blockId, design, { timeoutMs = 5000 } = {}) {
  await ensurePlain(blockId);
  const state = openConsole(blockId);
  const bytes = new TextEncoder().encode(JSON.stringify(design));
  await writeLine(blockId, `save-design ${bytes.length}`);
  const ready = await readLine(state, timeoutMs);
  if (!/^\[DESIGN] READY/.test(ready)) throw new Error(`Unexpected response: ${ready}`);
  await writeBytes(blockId, bytes);
  const result = await readLine(state, timeoutMs);
  if (!/Saved \d+ bytes OK/.test(result)) throw new Error(result || 'Save failed.');
  return result;
}
