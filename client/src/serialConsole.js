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
  await ensureOpenPlain(blockId);
  if (before?.esploader) closeConsole(blockId);
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
    const id = nextBlockId;
    nextBlockId += 1;
    idByChildId.set(child.id, id);
    blocks.push({
      id,
      type: direction,
      gx,
      gy,
      data: direction === 'din' ? { gpio: pin, emitOnChange: true } : { gpio: pin },
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
    const target = pinChildren.find((c) => c.id === conn.targetBlockId);
    if (!target) continue;
    const targetDir = (target.props || []).find((p) => p.name === 'direction')?.value === 'output' ? 'output' : 'input';
    if (targetDir !== 'output') continue; // only driving a real Output pin has firmware meaning
    if (idByChildId.has(target.id)) continue; // see fan-out/fan-in note above

    if (boolSource) {
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
export async function setPin(blockId, gpio, state, { timeoutMs = 2000 } = {}) {
  await ensurePlain(blockId);
  const consoleState = openConsole(blockId);
  await writeLine(blockId, `io ${gpio} ${state ? 1 : 0}`);
  const reply = await readLine(consoleState, timeoutMs);
  if (!/^\[IO] gpio=/.test(reply)) throw new Error(reply || 'Set pin failed.');
  return reply;
}

// Current gpio/output/state for every pin the board's loaded circuit
// declared — serial mirror of broadcastIO()'s WebSocket payload (see `pins`).
export async function readPins(blockId, { timeoutMs = 2000 } = {}) {
  await ensurePlain(blockId);
  const consoleState = openConsole(blockId);
  await writeLine(blockId, 'pins');
  const line = await readLine(consoleState, timeoutMs);
  let doc;
  try {
    doc = JSON.parse(line);
  } catch {
    throw new Error(`Unexpected response: ${line}`);
  }
  return Array.isArray(doc.pins) ? doc.pins : [];
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
