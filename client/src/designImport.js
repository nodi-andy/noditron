// Reads a circuit back out of esp32_logic's own design.json — belts on a
// grid, Factorio-style — into nodigraph blocks and wires inside the board
// block: the inverse of devkitCircuit.buildDevkitDesign. Where the
// compiler lays out one row per wired pair, this follows the belts the
// way the firmware does (see esp32_logic's circuitFireAll, propagateBelt
// and deliverToBlocks in conucon's main.cpp) and keeps only what those
// belts actually connect, so a design drawn by hand in conucon's own GUI
// reads back too, as long as it uses blocks noditron has a counterpart
// for.
//
// Pure: no DOM, no palette. The nodigraph blocks themselves come from
// `factories` (see deviceSync.js for the real ones), so this can be run
// and tested in node against the compiler's own output.

const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
// The firmware's own defaults when a block carries no w/h.
const DEFAULT_SIZE = { route: [1, 3] };

const key = (x, y) => `${x},${y}`;

// The signal graph of a design: its blocks (belts and junctions folded
// away) and one edge per belt run that leaves a block and lands in
// another. `output` is the row a Match (croute) fired from; `input` is
// which of an AND's two inputs a belt landed on, or a Route's channel.
export function traceDesign(design) {
  if (Array.isArray(design?.wires)) return traceWiredDesign(design);
  const raw = Array.isArray(design?.blocks) ? design.blocks : [];
  const belts = new Map();
  const juncs = new Map();
  const blocks = [];
  for (const b of raw) {
    const gx = Number(b.gx) || 0;
    const gy = Number(b.gy) || 0;
    const dir = String(b.data?.dir || 'E')[0];
    if (b.type === 'belt') { belts.set(key(gx, gy), dir); continue; }
    if (b.type === 'junc') { juncs.set(key(gx, gy), dir); continue; }
    const [dw, dh] = DEFAULT_SIZE[b.type] || [2, 2];
    blocks.push({
      id: b.id,
      type: String(b.type || ''),
      gx,
      gy,
      w: b.w == null ? dw : Number(b.w),
      h: b.h == null ? dh : Number(b.h),
      data: b.data && typeof b.data === 'object' ? b.data : {},
    });
  }
  const inside = (b, x, y) => x >= b.gx && x < b.gx + b.w && y >= b.gy && y < b.gy + b.h;

  // deliverToBlocks: a Route's channel cells and an AND's two input cells
  // are told apart; anything else takes a belt landing anywhere in its box.
  function deliver(x, y) {
    for (const b of blocks) {
      if (b.type === 'route' && x === b.gx) {
        if (y === b.gy) return { block: b, input: 0 };
        const ch = y - b.gy - 1;
        if (ch >= 0 && ch < b.h - 1) return { block: b, input: ch + 1 };
        continue;
      }
      if (b.type === 'and' && x === b.gx) {
        if (y === b.gy) return { block: b, input: 'a' };
        if (y === b.gy + 1) return { block: b, input: 'b' };
      }
      // A data block two or more rows tall: a belt on a lower row writes
      // (firmware build 20260928a and later), the top row triggers.
      if (b.type === 'data' && b.h >= 2 && inside(b, x, y)) return { block: b, input: y > b.gy ? 'write' : null };
      if (inside(b, x, y)) return { block: b, input: b.type === 'and' ? 'a' : null };
    }
    return null;
  }

  const edges = [];
  const seen = new Set();
  function addEdge(from, to, output, input) {
    const k = `${blocks.indexOf(from)}>${blocks.indexOf(to)}:${output}:${input}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, output, input });
  }
  // propagateBelt: along the belt, a junction copying in its own direction
  // as well; at the end of the run, whatever block the next cell is in.
  function follow(x, y, from, output, visited) {
    const k = key(x, y);
    if (visited.has(k)) return;
    visited.add(k);
    const belt = belts.get(k);
    const junc = juncs.get(k);
    if (!belt && !junc) return;
    const step = (dir) => {
      const [dx, dy] = DIRS[dir] || DIRS.E;
      const nx = x + dx;
      const ny = y + dy;
      if (belts.has(key(nx, ny)) || juncs.has(key(nx, ny))) {
        follow(nx, ny, from, output, visited);
        return;
      }
      const hit = deliver(nx, ny);
      if (hit && hit.block !== from) addEdge(from, hit.block, output, hit.input);
    };
    if (junc) {
      step(junc);
      if (belt && belt !== junc) step(belt);
      return;
    }
    step(belt);
  }

  for (const b of blocks) {
    // circuitFireAll: a belt on any face that leads away from the block.
    const away = (cx, cy, output) => {
      const dir = belts.get(key(cx, cy)) || juncs.get(key(cx, cy));
      if (!dir) return;
      const [dx, dy] = DIRS[dir] || DIRS.E;
      if (inside(b, cx + dx, cy + dy)) return;
      follow(cx, cy, b, output, new Set());
    };
    if (b.type === 'croute') {
      // A Match fires one row at a time, out of that row's own cell on
      // its right edge (crouteOutGx/Gy) — never its other faces.
      for (let i = 0; i < b.h; i += 1) away(b.gx + b.w, b.gy + i, i);
      continue;
    }
    if (b.type === 'route') {
      // A Route sends out of output i's cell, (gx+w, gy+1+i), for the
      // rows below its control row — never its other faces.
      for (let i = 0; i < b.h - 1; i += 1) away(b.gx + b.w, b.gy + 1 + i, i);
      continue;
    }
    for (let dx = 0; dx < b.w; dx += 1) {
      away(b.gx + dx, b.gy - 1, null);
      away(b.gx + dx, b.gy + b.h, null);
    }
    for (let dy = 0; dy < b.h; dy += 1) {
      away(b.gx - 1, b.gy + dy, null);
      away(b.gx + b.w, b.gy + dy, null);
    }
  }
  return { blocks, edges };
}

// Blocks whose outputs are told apart (out i) — everything else has one.
const MULTI_OUTPUT = new Set(['croute', 'route', 'slice', 'pwmin']);

// A wired design (firmware build 20261011a and later, see
// serialConsole.buildWiredDesign): the wires are the edges, already —
// [from id, output, to id, input] — read into the same shape the belts
// give, so loading and comparing do not care which kind a board holds.
function traceWiredDesign(design) {
  const blocks = (Array.isArray(design.blocks) ? design.blocks : []).map((b) => ({
    id: b.id,
    type: String(b.type || ''),
    w: b.w == null ? 2 : Number(b.w),
    h: b.h == null ? 2 : Number(b.h),
    data: b.data && typeof b.data === 'object' ? b.data : {},
    ...(Array.isArray(b.at) ? { at: b.at } : {}),
  }));
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const edges = [];
  const seen = new Set();
  for (const w of design.wires) {
    if (!Array.isArray(w)) continue;
    const from = byId.get(w[0]);
    const to = byId.get(w[2]);
    if (!from || !to) continue;
    const sport = Number(w[1]) || 0;
    const dport = Number(w[3]) || 0;
    const output = MULTI_OUTPUT.has(from.type) ? sport : null;
    let input = null;
    if (to.type === 'route') input = dport;
    else if (to.type === 'and' || to.type === 'or') input = dport === 1 ? 'b' : 'a';
    else if (to.type === 'data' && dport === 1) input = 'write';
    const k = `${w[0]}>${w[2]}:${output}:${input}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ from, to, output, input });
  }
  return { blocks, edges };
}

function portIdOf(block, name) {
  const logical = (block?.logicalPorts || []).find((lp) => lp.name === name);
  const pin = logical && (block.ports || []).find((p) => p.logicalId === logical.id);
  return pin ? pin.id : null;
}

function outputPortIds(block) {
  return (block.ports || [])
    .map((pin) => (block.logicalPorts || []).find((lp) => lp.id === pin.logicalId))
    .filter((lp) => lp && lp.direction === 'out')
    .map((lp) => (block.ports || []).find((p) => p.logicalId === lp.id).id);
}

const isUsbSerial = (b) => b.type === 'serial' && Number(b.data?.uart ?? 0) === 0;

// Builds the design's circuit inside `esp`. Board pins (a din on a GPIO
// the board draws, a dout on an EXIO, CAN, USB) become wires to the
// block's own boundary pins; everything else becomes a child block from
// `factories`: { data(value), match(routes, outputs), and(), timer(on,
// off), digitalIo(gpio, direction), connection({...}) }. `replace` clears
// what is inside first. Returns what was made and what could not be.
// The CNC block's pin ports and the grbl setting each one is — the same
// table as devkitCircuit's CNC_PIN_PATHS, read the other way: a setting
// naming a GPIO is a wire from that port to the board pin on it.
const CNC_PIN_PORTS = {
  'x/step/pin': 'X step', 'x/dir/pin': 'X dir', 'y/step/pin': 'Y step', 'y/dir/pin': 'Y dir',
  'stepper/disable/pin': 'enable', 'x/limit/pin': 'X limit', 'y/limit/pin': 'Y limit',
};
const CNC_INPUT_PORTS = new Set(['X limit', 'Y limit']);

export function importDesign({ design, esp, pinMap = [], factories, replace = false }) {
  const { blocks, edges } = traceDesign(design);
  esp.hasChildren = true;
  if (!esp.children) esp.children = { blocks: new Map(), connections: new Map() };
  // What was there, put back if nothing of the device's circuit can be
  // made here: replacing the CNC board's drawing with a design of only a
  // `cnc` block (which this did not know) left the board empty.
  const before = replace ? { blocks: new Map(esp.children.blocks), connections: new Map(esp.children.connections) } : null;
  if (replace) {
    esp.children.blocks.clear();
    esp.children.connections.clear();
  }
  // The CNC: one block however many firmware blocks stand for it (its
  // `in`/`out` as `cnc`, its home input as `cnchome`), made with the
  // settings the design carries (see devkitCircuit's CNC section).
  const cncSettings = blocks.find((b) => b.type === 'cnc' && b.data?.settings)?.data.settings || null;
  let cncChild = null;

  // Helpers the compiler adds that have no block of their own here: the
  // boot that wakes a constant once, and the clock that resends a Data
  // over USB, which the compiler marks (`role: 'usb-resend'`, see
  // serialConsole.buildMinimalDesign) because a Timer the user drew into
  // a Data ticks exactly the same. Dropping them keeps the wire the user
  // drew — Data straight to its pin.
  const dropped = new Set(blocks.filter((b) => b.type === 'boot' || (b.type === 'timer' && b.data?.role === 'usb-resend')));

  const pinByGpio = (gpio) => pinMap.find((p) => p.gpio !== null && p.gpio !== undefined && Number(p.gpio) === Number(gpio));
  const pinByExio = (exio) => pinMap.find((p) => p.exio !== undefined && Number(p.exio) === Number(exio));
  const boardPort = (label) => (label ? portIdOf(esp, label) : null);
  const usbLabel = pinMap.find((p) => p.role === 'usb-serial')?.label || null;

  const created = [];
  const skipped = [];
  const resolved = new Map(); // firmware block -> { board: portId } | { child }
  let canSpeedDone = false;

  function childFor(b, make) {
    const child = make();
    created.push({ child, source: b });
    return { child };
  }

  function resolve(b, role) {
    if (resolved.has(b)) return resolved.get(b);
    let r = null;
    const d = b.data || {};
    if (b.type === 'din') {
      const pin = pinByGpio(d.gpio);
      const port = pin && boardPort(pin.label);
      r = port ? { board: port } : childFor(b, () => factories.digitalIo(Number(d.gpio), 'input'));
    } else if (b.type === 'dout') {
      const pin = d.exio ? pinByExio(d.exio) : pinByGpio(d.gpio);
      const port = pin && boardPort(pin.label);
      r = port ? { board: port } : childFor(b, () => factories.digitalIo(d.exio ? 1000 + Number(d.exio) - 1 : Number(d.gpio), 'output'));
    } else if (b.type === 'can') {
      const port = boardPort('CAN') || boardPort(role === 'source' ? 'CAN In' : 'CAN Out');
      r = port ? { board: port } : null;
      const bitrate = Number(d.bitrate);
      const speedPort = boardPort('CAN speed');
      if (!canSpeedDone && bitrate && bitrate !== 250000 && speedPort) {
        canSpeedDone = true;
        const { child } = childFor(b, () => factories.data(`${bitrate / 1000}k`));
        connect(child.id, portIdOf(child, 'out'), esp.id, speedPort);
      }
    } else if (b.type === 'data') {
      r = childFor(b, () => factories.data(String(d.value ?? '')));
    } else if (b.type === 'croute') {
      const routes = Array.isArray(d.routes) ? d.routes.map((m) => (m === null || m === undefined ? '' : String(m))) : [];
      r = childFor(b, () => factories.match(routes, Math.max(routes.length, b.h, 1)));
    } else if (b.type === 'and') {
      r = childFor(b, () => factories.and());
    } else if (b.type === 'or' && factories.or) {
      r = childFor(b, () => factories.or());
    } else if (b.type === 'not' && factories.not) {
      r = childFor(b, () => factories.not());
    } else if (b.type === 'timer' && d.mode === 'delay' && factories.delay) {
      r = childFor(b, () => factories.delay(Number(d.onTime) || 100));
    } else if (b.type === 'timer') {
      r = childFor(b, () => factories.timer(Number(d.onTime) || 500, Number(d.offTime) || 500));
    } else if (b.type === 'route' && factories.route) {
      r = childFor(b, () => factories.route());
    } else if ((b.type === 'cnc' || b.type === 'cnchome') && factories.cnc) {
      if (!cncChild) cncChild = childFor(b, () => factories.cnc(cncSettings || {})).child;
      r = { child: cncChild };
    } else if (isUsbSerial(b)) {
      const port = boardPort(usbLabel);
      r = port ? { board: port } : null;
    }
    if (!r && !skipped.includes(b.type)) skipped.push(b.type);
    resolved.set(b, r);
    return r;
  }

  const connections = [];
  const wired = new Set();
  function connect(sourceBlockId, sourcePortId, targetBlockId, targetPortId) {
    if (!sourcePortId || !targetPortId) return;
    const k = `${sourcePortId}>${targetPortId}`;
    if (wired.has(k)) return;
    wired.add(k);
    connections.push(factories.connection({ sourceBlockId, sourcePortId, targetBlockId, targetPortId }));
  }

  function sourceEnd(b, edge) {
    const r = resolve(b, 'source');
    if (!r) return null;
    if (r.board) return { blockId: esp.id, portId: r.board };
    const child = r.child;
    if (b.type === 'croute') {
      const outs = outputPortIds(child);
      return { blockId: child.id, portId: outs[edge.output ?? 0] || null };
    }
    if (b.type === 'cnc') return { blockId: child.id, portId: portIdOf(child, 'out') };
    if (b.type === 'route') {
      // Output i is out(i+1); out3/out4 ship hidden and show once wired.
      const name = `out${(edge.output ?? 0) + 1}`;
      const logical = (child.logicalPorts || []).find((lp) => lp.name === name);
      if (logical) delete logical.hidden;
      return { blockId: child.id, portId: portIdOf(child, name) };
    }
    return { blockId: child.id, portId: portIdOf(child, 'out') || portIdOf(child, 'value') };
  }
  function targetEnd(b, edge) {
    const r = resolve(b, 'target');
    if (!r) return null;
    if (r.board) return { blockId: esp.id, portId: r.board };
    const child = r.child;
    if (b.type === 'and' || b.type === 'or') return { blockId: child.id, portId: portIdOf(child, edge.input === 'b' ? 'b' : 'a') };
    if (b.type === 'timer' && b.data?.mode === 'delay') return { blockId: child.id, portId: portIdOf(child, 'in') };
    if (b.type === 'timer') return null; // nothing feeds a timer
    if (b.type === 'route') return { blockId: child.id, portId: portIdOf(child, edge.input === 0 ? 'sel' : 'in') };
    if (b.type === 'cnc') return { blockId: child.id, portId: portIdOf(child, 'in') };
    if (b.type === 'cnchome') return { blockId: child.id, portId: portIdOf(child, 'home') };
    if (b.type === 'data' && edge.input === 'write') {
      // The write port is hidden on a fresh Data (see palette.js); a wire
      // into it shows it, as the Inspector would.
      const logical = (child.logicalPorts || []).find((lp) => lp.name === 'write');
      if (logical) delete logical.hidden;
      return { blockId: child.id, portId: portIdOf(child, 'write') };
    }
    return { blockId: child.id, portId: portIdOf(child, 'in') || portIdOf(child, 'value') };
  }

  // Every block first, so one nobody wired to (a lone declared pin) still
  // comes back — as a board pin it needs nothing, as anything else it
  // stands on its own.
  for (const b of blocks) if (!dropped.has(b)) resolve(b, edges.some((e) => e.to === b) ? 'target' : 'source');
  for (const edge of edges) {
    if (dropped.has(edge.from) || dropped.has(edge.to)) continue;
    const from = sourceEnd(edge.from, edge);
    const to = targetEnd(edge.to, edge);
    if (!from || !to) continue;
    connect(from.blockId, from.portId, to.blockId, to.portId);
  }
  // The CNC's pin settings as the wires they were drawn as.
  if (cncChild && cncSettings) {
    for (const [path, portName] of Object.entries(CNC_PIN_PORTS)) {
      const gpio = Number(cncSettings[path]);
      if (!(gpio >= 0)) continue;
      const pin = pinByGpio(gpio);
      const boardPin = pin && boardPort(pin.label);
      const cncPort = portIdOf(cncChild, portName);
      if (!boardPin || !cncPort) continue;
      if (CNC_INPUT_PORTS.has(portName)) connect(esp.id, boardPin, cncChild.id, cncPort);
      else connect(cncChild.id, cncPort, esp.id, boardPin);
    }
  }
  if (before && !created.length && !connections.length && blocks.length && skipped.length) {
    for (const [id, block] of before.blocks) esp.children.blocks.set(id, block);
    for (const [id, conn] of before.connections) esp.children.connections.set(id, conn);
    return { created: [], connections: [], skipped, restored: true };
  }

  // Left to right by how far a block sits from the sources, top to bottom
  // in the order the design listed them — nothing fancy, just legible.
  const childIds = new Set(created.map((c) => c.child.id));
  const preds = new Map();
  for (const conn of connections) {
    if (!childIds.has(conn.sourceBlockId) || !childIds.has(conn.targetBlockId)) continue;
    if (!preds.has(conn.targetBlockId)) preds.set(conn.targetBlockId, new Set());
    preds.get(conn.targetBlockId).add(conn.sourceBlockId);
  }
  const depth = new Map();
  const depthOf = (id, trail = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (trail.has(id)) return 0;
    trail.add(id);
    const ps = [...(preds.get(id) || [])];
    const d = ps.length ? 1 + Math.max(...ps.map((p) => depthOf(p, trail))) : 0;
    depth.set(id, d);
    return d;
  };
  const COLUMN = 260;
  const GAP = 30;
  const MARGIN = 40;
  const columnY = new Map();
  let maxX = 0;
  let maxY = 0;
  for (const { child, source } of created) {
    // A wired design keeps where each block was drawn (`at`); a belt
    // design, or a block without one, is laid out by depth.
    if (Array.isArray(source.at) && source.at.length === 2) {
      child.geometry.x = Number(source.at[0]) || 0;
      child.geometry.y = Number(source.at[1]) || 0;
    } else {
      const col = depthOf(child.id);
      const y = columnY.get(col) ?? MARGIN;
      child.geometry.x = MARGIN + col * COLUMN;
      child.geometry.y = y;
      columnY.set(col, y + child.geometry.height + GAP);
    }
    maxX = Math.max(maxX, child.geometry.x + child.geometry.width);
    maxY = Math.max(maxY, child.geometry.y + child.geometry.height);
    esp.children.blocks.set(child.id, child);
  }
  for (const conn of connections) esp.children.connections.set(conn.id, conn);
  if (created.length) {
    const frame = esp.boundaryGeometry || { x: 0, y: 0, width: 320, height: 240 };
    esp.boundaryGeometry = {
      x: frame.x,
      y: frame.y,
      width: Math.max(frame.width, maxX + MARGIN - frame.x),
      height: Math.max(frame.height, maxY + MARGIN - frame.y),
    };
  }
  return { created: created.map((c) => c.child), connections, skipped };
}
