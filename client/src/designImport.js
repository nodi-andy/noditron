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
        if (ch >= 0 && ch < b.h) return { block: b, input: ch + 1 };
        continue;
      }
      if (b.type === 'and' && x === b.gx) {
        if (y === b.gy) return { block: b, input: 'a' };
        if (y === b.gy + 1) return { block: b, input: 'b' };
      }
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
export function importDesign({ design, esp, pinMap = [], factories, replace = false }) {
  const { blocks, edges } = traceDesign(design);
  esp.hasChildren = true;
  if (!esp.children) esp.children = { blocks: new Map(), connections: new Map() };
  if (replace) {
    esp.children.blocks.clear();
    esp.children.connections.clear();
  }

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
      const port = boardPort(role === 'source' ? 'CAN In' : 'CAN Out');
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
    } else if (b.type === 'timer') {
      r = childFor(b, () => factories.timer(Number(d.onTime) || 500, Number(d.offTime) || 500));
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
    return { blockId: child.id, portId: portIdOf(child, 'out') || portIdOf(child, 'value') };
  }
  function targetEnd(b, edge) {
    const r = resolve(b, 'target');
    if (!r) return null;
    if (r.board) return { blockId: esp.id, portId: r.board };
    const child = r.child;
    if (b.type === 'and') return { blockId: child.id, portId: portIdOf(child, edge.input === 'b' ? 'b' : 'a') };
    if (b.type === 'timer') return null; // nothing feeds a timer
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
  for (const { child } of created) {
    const col = depthOf(child.id);
    const y = columnY.get(col) ?? MARGIN;
    child.geometry.x = MARGIN + col * COLUMN;
    child.geometry.y = y;
    columnY.set(col, y + child.geometry.height + GAP);
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
