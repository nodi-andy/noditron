import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { kindOf } from './runtime.js';
import * as serialConsole from './serialConsole.js';
import { traceDesign } from './designImport.js';

function logicalName(block, portId) {
  const pin = (block.ports || []).find((p) => p.id === portId);
  const logical = pin && (block.logicalPorts || []).find((lp) => lp.id === pin.logicalId);
  return logical?.name || null;
}

function pinMapFor(block) {
  const prop = (block.props || []).find((p) => p.name === 'pinMap');
  try {
    const map = JSON.parse(prop?.value || '[]');
    return Array.isArray(map) ? map : [];
  } catch {
    return [];
  }
}

// The firmware build a board runs: what it said this session, else what it
// said last time (the `firmwareBuild` prop main.js keeps).
export function boardBuildOf(esp) {
  return serialConsole.firmwareBuildOf?.(esp.id) || propValue(esp, 'firmwareBuild', '') || null;
}

function propValue(block, name, fallback = '') {
  return (block.props || []).find((p) => p.name === name)?.value ?? fallback;
}

// Keep IDs (and wires) for terminals with a known equivalent. Obsolete wired
// pins remain visible as legacy ports so changing the board cannot lose a wire.
export function migrateWaveshareBoard(block, template, level) {
  if (propValue(template, 'boardVariant') !== 'ESP32-S3-POE-ETH-8DI-8DO') return false;
  let changed = false;
  if (block.name === 'ESP32-S3 DevKit') { block.name = 'esp32-S3'; changed = true; }
  const alreadyWaveshare = propValue(block, 'boardVariant') === 'ESP32-S3-POE-ETH-8DI-8DO';
  const aliases = new Map(Array.from({ length: 8 }, (_, i) => [`G${i + 4}`, `DI${i + 1}`]));
  // One CAN pin now: the old CAN Out (and its older names) becomes it; an
  // old CAN In is dropped unless wired, then kept as a legacy pin.
  aliases.set('G2', 'CAN'); aliases.set('CAN TX', 'CAN'); aliases.set('CAN Out', 'CAN');
  aliases.set('G17', 'RS485 TX'); aliases.set('G18', 'RS485 RX');
  const connections = [...(level?.connections?.values?.() || []), ...(block.children?.connections?.values?.() || [])];
  const retained = new Set();
  for (const logical of block.logicalPorts || []) {
    const name = aliases.get(logical.name) || logical.name;
    const replacement = template.logicalPorts.find(p => p.name === name);
    const ports = block.ports.filter(p => p.logicalId === logical.id);
    const wired = ports.some(p => connections.some(c =>
      (c.sourceBlockId === block.id && c.sourcePortId === p.id) || (c.targetBlockId === block.id && c.targetPortId === p.id)));
    if (replacement) {
      const renamed = logical.name !== name;
      if (renamed || logical.direction !== replacement.direction || logical.description !== replacement.description) changed = true;
      logical.name = name;
      logical.direction = replacement.direction;
      logical.description = replacement.description;
      // Template positions only when a pin first becomes a Waveshare
      // terminal. After that the user's own slot placement is kept.
      if (!alreadyWaveshare || renamed) {
        const position = template.ports.find(p => p.logicalId === replacement.id);
        for (const p of ports) Object.assign(p, { side: position.side, offset: position.offset, manualOffset: true });
      }
      retained.add(logical.id);
    } else if (wired) {
      logical.description = 'Legacy DevKit pin; reconnect to a terminal on the Waveshare board.';
      retained.add(logical.id);
    }
  }
  block.logicalPorts = block.logicalPorts.filter(p => retained.has(p.id));
  block.ports = block.ports.filter(p => retained.has(p.logicalId));
  // Existing Waveshare blocks still pass through this sync. Module v1.6.0
  // exposed signal-flow directions on the outer face; updating the module
  // alone would otherwise leave already placed blocks reversed forever.
  return changed || !alreadyWaveshare;
}

// A board placed from an older pin layout of its module (the template's
// `pinLayout` prop is newer): its pins take the template's slots, matched
// by name, so every wire stays on its pin; a pin the module no longer has
// goes, unless a wire is on it. Once — the prop then matches, and slots
// the user moves after that are kept.
export function relayoutBoard(block, template, level) {
  const want = String(propValue(template, 'pinLayout', ''));
  if (!want || String(propValue(block, 'pinLayout', '')) === want) return false;
  const connections = [...(level?.connections?.values?.() || []), ...(block.children?.connections?.values?.() || [])];
  const wired = (logical) => (block.ports || []).some((p) => p.logicalId === logical.id && connections.some((c) =>
    (c.sourceBlockId === block.id && c.sourcePortId === p.id) || (c.targetBlockId === block.id && c.targetPortId === p.id)));
  const keep = new Set();
  for (const logical of block.logicalPorts || []) {
    const tplLogical = (template.logicalPorts || []).find((lp) => lp.name === logical.name);
    const tplPin = tplLogical && (template.ports || []).find((p) => p.logicalId === tplLogical.id);
    if (tplPin) {
      for (const p of block.ports || []) {
        if (p.logicalId === logical.id) Object.assign(p, { side: tplPin.side, offset: tplPin.offset, manualOffset: true });
      }
      keep.add(logical.id);
    } else if (wired(logical)) {
      keep.add(logical.id);
    }
  }
  block.logicalPorts = (block.logicalPorts || []).filter((lp) => keep.has(lp.id));
  block.ports = (block.ports || []).filter((p) => keep.has(p.logicalId));
  if (template.geometry?.height > (block.geometry?.height || 0)) block.geometry.height = template.geometry.height;
  const prop = (block.props || []).find((p) => p.name === 'pinLayout');
  if (prop) prop.value = want;
  else block.props.push({ id: `prp_pinlayout_${block.id}`, name: 'pinLayout', kind: 'value', value: want });
  return true;
}

// The board a block belongs to: the block itself when it is one, else the
// innermost board holding it — a CNC block inside an S3 board reaches
// grbl through that board's link. Null when no board holds it.
export function findOwningBoard(level, blockId, owner = null) {
  if (!level) return null;
  for (const block of level.blocks?.values?.() || []) {
    const board = BOARD_KINDS.includes(kindOf(block)) ? block : owner;
    if (block.id === blockId) return board;
    const found = findOwningBoard(block.children, blockId, board);
    if (found) return found;
  }
  return null;
}

export function findContainingLevel(level, blockId) {
  if (!level) return null;
  if (level.blocks?.has(blockId)) return level;
  for (const block of level.blocks?.values?.() || []) {
    const found = findContainingLevel(block.children, blockId);
    if (found) return found;
  }
  return null;
}

// Any connection endpoint that lands on the ESP32 block ITSELF is a pin,
// not a block — from outside that's one of its exterior pins, from inside
// it's the same pin drawn on the boundary frame (a wire drawn inside a
// container stores the container's OWN id as its endpoint, see
// Project.listBoundaryWires). Either way the pin compiles to a synthetic
// din/dout carrying that GPIO, so the board's own pins can be wired
// directly and a Digital I/O box is only needed for a pin the block
// doesn't already draw.
//
// Direction comes from which end of the wire the pin sits on, since these
// pins declare none of their own (every logicalPort on the DevKit module is
// `direction: null` — a GPIO is genuinely either until something wires it):
// driven by something => output, driving something => input. Wiring a
// Timer's `out` into D2 is therefore a complete, uploadable circuit on its
// own — that's the whole point of the pins being on the block.
// What the far end of each of the board's `socket` pins is, seen from the
// level the board sits on (see socketLink.js for the port itself). The
// board's socket is a channel of its shell (conucon's socketOut): the
// design saved to it carries where the socket leads, as `dest` — the far
// board's node id (its `nodeId` prop, recorded from `nodes` by the
// dialog) with its name as a fallback, or 'host' when the wire reaches an
// ordinary block or nothing at all, meaning the browser. Keyed by port id.
export function socketLinksFor(esp, level) {
  const links = new Map();
  const socketPorts = (esp.ports || []).filter((port) => pinMapFor(esp).find((pin) => pin.label === logicalName(esp, port.id))?.role === 'socket');
  for (const port of socketPorts) {
    let link = { far: 'host', dest: 'host', name: '' };
    for (const conn of level?.connections?.values?.() || []) {
      const otherId = conn.sourceBlockId === esp.id && conn.sourcePortId === port.id ? conn.targetBlockId
        : conn.targetBlockId === esp.id && conn.targetPortId === port.id ? conn.sourceBlockId : null;
      if (!otherId || otherId === esp.id) continue;
      const other = level.blocks?.get?.(otherId);
      if (other && BOARD_KINDS.includes(kindOf(other))) {
        // Its node id (recorded by the dialog from identify), else the name
        // the node calls itself, else what the diagram calls it.
        link = { far: 'board', dest: propValue(other, 'nodeId', '') || propValue(other, 'nodeName', '') || other.name || '', name: propValue(other, 'nodeName', '') || other.name || '' };
      }
    }
    links.set(port.id, link);
  }
  return links;
}

// `socketLinks` (see socketLinksFor) says where each socket pin leads;
// `face` is 'internal' for the board's own children, 'external' for the
// level around it, where a socket wire is the link itself and compiles to
// nothing.
function buildPinMappedDesign(esp, blocks, connections, { socketLinks = new Map(), face = 'internal', notes = null } = {}) {
  const allPinsByPortName = new Map(pinMapFor(esp).map((pin) => [pin.label, pin]));
  const pinsByPortName = new Map(
    pinMapFor(esp)
      .filter((pin) => pin.gpio !== null && pin.gpio !== undefined)
      .map((pin) => [pin.label, pin]),
  );
  const syntheticPins = new Map();
  const socketPinPorts = new Map(); // synthetic socket pin block id -> the board's socket port id
  const CAN_OUT_GPIO = 2000;
  // The socket pin, as a pin the layout already knows how to place (see
  // serialConsole.buildMinimalDesign's din/dout rows), rewritten below
  // into the firmware's `socket` block.
  const SOCKET_OUT_GPIO = 2002;
  const SOCKET_IN_GPIO = 2003;
  const socketLinkOf = (portId) => socketLinks.get(portId) || { far: 'host', dest: 'host', name: '' };
  const CAN_IN_GPIO = 2001;
  // The CNC pin (logic-cnc firmware: grbl built in), the same way.
  const CNC_OUT_GPIO = 2004;
  const CNC_IN_GPIO = 2005;
  const CNC_HOME_GPIO = 2006; // the CNC's `home`: a rising signal homes it
  let canBitrate = 250000;

  const speedPort = (esp.ports || []).find((port) => logicalName(esp, port.id) === 'CAN speed');
  const speedConnection = speedPort && connections.find((conn) => conn.targetBlockId === esp.id && conn.targetPortId === speedPort.id);
  if (speedConnection) {
    const source = blocks.find((block) => block.id === speedConnection.sourceBlockId);
    const raw = String(propValue(source || {}, 'value', '250k')).trim().toLowerCase();
    const parsed = raw.endsWith('k') ? Number(raw.slice(0, -1)) * 1000 : Number(raw);
    if ([50000, 100000, 125000, 250000, 500000, 800000, 1000000].includes(parsed)) canBitrate = parsed;
  }
  // The board's USB pin (pinMap role usb-serial): a wire into it sends its
  // value to the browser over USB (see serialConsole.buildMinimalDesign).
  const usbPortNames = new Set(pinMapFor(esp).filter((pin) => pin.role === 'usb-serial').map((pin) => pin.label));
  const usbTarget = {
    id: `${esp.id}:usb`,
    name: 'USB',
    logicalPorts: [{ id: `${esp.id}:usb:io`, name: 'in', direction: 'in' }],
    ports: [{ id: `${esp.id}:usb:port`, logicalId: `${esp.id}:usb:io`, side: 'left', offset: 20, manualOffset: true }],
    props: [{ id: `${esp.id}:usb:kind`, name: 'noditronKind', kind: 'value', value: 'usb-serial' }],
  };
  let usesUsb = false;

  function syntheticPinBlock(pin, direction) {
    const gpio = Number(pin.gpio);
    const key = `${direction}:${gpio}`;
    if (syntheticPins.has(key)) return syntheticPins.get(key);
    const block = {
      id: `${esp.id}:${key}`,
      name: pin.label,
      logicalPorts: [{ id: `${esp.id}:${key}:io`, name: 'value', direction: direction === 'output' ? 'in' : 'out' }],
      ports: [{ id: `${esp.id}:${key}:port`, logicalId: `${esp.id}:${key}:io`, side: direction === 'output' ? 'left' : 'right', offset: 20, manualOffset: true }],
      props: [
        { id: `${esp.id}:${key}:pin`, name: 'pin', kind: 'value', value: gpio },
        { id: `${esp.id}:${key}:dir`, name: 'direction', kind: 'value', value: direction },
        { id: `${esp.id}:${key}:value`, name: 'value', kind: 'range', min: 0, max: 1, value: 0 },
        { id: `${esp.id}:${key}:kind`, name: 'noditronKind', kind: 'value', value: 'digital-io' },
        ...(pin.exio ? [{ id: `${esp.id}:${key}:exio`, name: 'exio', kind: 'value', value: pin.exio }] : []),
        // A pin the firmware may declare more than once (serialConsole's
        // Route sections place a CAN block per row that sends or receives):
        // every `can` block transmits what it is given and fires what the
        // bus delivers (conucon main.cpp circuitRecv / canDrain).
        ...(pin.repeatable ? [{ id: `${esp.id}:${key}:repeatable`, name: 'repeatable', kind: 'value', value: true }] : []),
      ],
    };
    syntheticPins.set(key, block);
    return block;
  }

  function mapEndpoint(blockId, portId, isTarget) {
    if (blockId !== esp.id) return { blockId, portId };
    const portName = logicalName(esp, portId);
    const boardPin = allPinsByPortName.get(portName);
    if (boardPin?.role === 'can-speed') {
      if (!isTarget) throw new Error('CAN speed only accepts a configured value.');
      return null; // compile-time configuration, not a runtime signal path
    }
    // The socket pin, wired from inside, is the board's own `socket`
    // block: what the circuit puts in is announced on the board's shell
    // as `socket out: …` and delivered to the node the socket is wired to
    // outside (`dest`, see socketLinksFor), and what arrives at the
    // socket from outside (`socket in: …`) is what a wire from the pin
    // carries into the circuit. From the level around the board the
    // socket wire IS the link and compiles to nothing.
    if (boardPin?.role === 'socket') {
      if (face !== 'internal') return null;
      const pin = syntheticPinBlock({ label: 'socket', gpio: isTarget ? SOCKET_OUT_GPIO : SOCKET_IN_GPIO }, isTarget ? 'output' : 'input');
      socketPinPorts.set(pin.id, portId);
      return { blockId: pin.id, portId: pin.ports[0].id };
    }
    // The CAN pin, like a GPIO: driven by something, it sends on the bus;
    // driving something, it carries what the bus delivers. Older boards'
    // separate CAN Out / CAN In pins compile the same way.
    if (boardPin?.role === 'can' || boardPin?.role === 'can-out' || boardPin?.role === 'can-in') {
      if (boardPin.role === 'can-out' && !isTarget) throw new Error('CAN Out only accepts data to transmit.');
      if (boardPin.role === 'can-in' && isTarget) throw new Error('CAN In only provides received data.');
      const pin = syntheticPinBlock({ label: 'CAN', gpio: isTarget ? CAN_OUT_GPIO : CAN_IN_GPIO, repeatable: true }, isTarget ? 'output' : 'input');
      return { blockId: pin.id, portId: pin.ports[0].id };
    }
    if (usbPortNames.has(portName)) {
      if (!isTarget) return null; // reading from USB into the circuit is not a thing yet
      usesUsb = true;
      return { blockId: usbTarget.id, portId: usbTarget.ports[0].id };
    }
    const mappedPin = pinsByPortName.get(portName);
    if (!mappedPin) {
      if (propValue(esp, 'boardVariant') === 'ESP32-S3-POE-ETH-8DI-8DO') {
        throw new Error(`${portName} is not a digital terminal on this Waveshare board. Reconnect the wire to DI1–DI8 or DO1–DO8.`);
      }
      return null;
    }
    if (cncPinUse.has(Number(mappedPin.gpio))) {
      throw new Error(`${portName} is the CNC's ${cncPinUse.get(Number(mappedPin.gpio))}; wire the circuit to another pin.`);
    }
    if (mappedPin.reserved || (isTarget && mappedPin.inputOnly) || (!isTarget && mappedPin.outputOnly)) {
      throw new Error(`${portName} cannot be used as a digital ${isTarget ? 'output' : 'input'}.`);
    }
    const pin = syntheticPinBlock(mappedPin, isTarget ? 'output' : 'input');
    return { blockId: pin.id, portId: pin.ports[0].id };
  }

  // The CNC block (palette.js's createCncBlock): grbl, built into the
  // board's firmware. `in` and `out` compile like the CAN pin, into the
  // firmware's `cnc` block; the step / dir / enable / limit ports are
  // grbl's pin settings — a wire from `X step` to IO4 is x/step/pin 4 and
  // nothing at run time, an unwired one is no pin (-1) — and the named
  // values in its subgraph are the rest of its settings (cncSettingsOf).
  // The circuit is the machine's settings: they ride on the `cnc` block,
  // and the board puts them into grbl when the circuit loads.
  const cncBlocks = blocks.filter((block) => kindOf(block) === 'cnc');
  if (cncBlocks.length > 1) throw new Error('One CNC per board: its firmware runs one grbl.');
  const cnc = cncBlocks[0] || null;
  const cncPinUse = new Map(); // gpio -> the CNC port wired to it
  const cncSettings = cnc ? { ...cncSettingsOf(cnc) } : null;
  if (cnc) for (const path of Object.values(CNC_PIN_PATHS)) cncSettings[path] = -1;
  const runtimeConnections = [];
  for (const conn of connections) {
    const cncEnd = !cnc ? null : conn.sourceBlockId === cnc.id ? 'source' : conn.targetBlockId === cnc.id ? 'target' : null;
    if (!cncEnd) { runtimeConnections.push(conn); continue; }
    const portName = logicalName(cnc, cncEnd === 'source' ? conn.sourcePortId : conn.targetPortId);
    if (portName === 'home' && cncEnd === 'target') {
      const pin = syntheticPinBlock({ label: 'CNC home', gpio: CNC_HOME_GPIO }, 'output');
      runtimeConnections.push({ ...conn, targetBlockId: pin.id, targetPortId: pin.ports[0].id });
      continue;
    }
    if (portName === 'in' || portName === 'out') {
      const pin = syntheticPinBlock({ label: 'CNC', gpio: portName === 'in' ? CNC_OUT_GPIO : CNC_IN_GPIO }, portName === 'in' ? 'output' : 'input');
      runtimeConnections.push(cncEnd === 'source'
        ? { ...conn, sourceBlockId: pin.id, sourcePortId: pin.ports[0].id }
        : { ...conn, targetBlockId: pin.id, targetPortId: pin.ports[0].id });
      continue;
    }
    const path = CNC_PIN_PATHS[portName];
    if (!path) continue;
    const otherBlockId = cncEnd === 'source' ? conn.targetBlockId : conn.sourceBlockId;
    const otherPortId = cncEnd === 'source' ? conn.targetPortId : conn.sourcePortId;
    if (otherBlockId !== esp.id) throw new Error(`CNC ${portName} goes to one of the board's pins.`);
    const boardPinName = logicalName(esp, otherPortId);
    const boardPin = pinsByPortName.get(boardPinName);
    const gpio = Number(boardPin?.gpio);
    if (!boardPin || !(gpio >= 0 && gpio < 1000) || boardPin.reserved) {
      throw new Error(`CNC ${portName} needs one of the chip's own GPIOs; ${boardPinName} is not one.`);
    }
    if (cncPinUse.has(gpio) && cncPinUse.get(gpio) !== portName) {
      throw new Error(`${boardPinName} cannot be both the CNC's ${cncPinUse.get(gpio)} and its ${portName}.`);
    }
    cncPinUse.set(gpio, portName);
    cncSettings[path] = gpio;
  }

  const mapped = [];
  for (const conn of runtimeConnections) {
    const source = mapEndpoint(conn.sourceBlockId, conn.sourcePortId, false);
    const target = mapEndpoint(conn.targetBlockId, conn.targetPortId, true);
    if (!source || !target) continue;
    mapped.push({
      ...conn,
      sourceBlockId: source.blockId,
      sourcePortId: source.portId,
      targetBlockId: target.blockId,
      targetPortId: target.portId,
    });
  }

  // The board's own CAN transceiver pins (its module's `canPins`): the
  // firmware starts TWAI on exactly what the `can` block names, and the
  // 2IO board's transceiver is on 15/16, not the 8IO's 2/3 this used to
  // write for every board — a CAN circuit saved to a 2IO board had no bus
  // and drove GPIO2 as an output.
  let canPins = { tx: 2, rx: 3 };
  try {
    const declared = JSON.parse(propValue(esp, 'canPins', '') || 'null');
    if (Number.isInteger(declared?.tx) && Number.isInteger(declared?.rx)) canPins = { tx: declared.tx, rx: declared.rx };
  } catch { /* no canPins on this board: the 8IO's own */ }
  // Wires for a board whose firmware runs them (see
  // serialConsole.buildWiredDesign), the grid layouts for an older one —
  // which says so beside whatever those layouts had to leave out.
  const runtimeBlocks = [...blocks.filter((block) => block !== cnc), ...syntheticPins.values(), ...(usesUsb ? [usbTarget] : [])];
  const build = boardBuildOf(esp);
  const wired = Boolean(serialConsole.buildWiredDesign) && serialConsole.runsWires?.(build);
  const notesBefore = notes ? notes.length : 0;
  const markedBefore = notes?.byBlock instanceof Map ? new Set(notes.byBlock.keys()) : null;
  const design = wired
    ? serialConsole.buildWiredDesign(runtimeBlocks, mapped, notes)
    : serialConsole.buildMinimalDesign(runtimeBlocks, mapped, notes);
  // On a block, the grid's own reasons ("needs an Input pin of its own",
  // "no layout for this shape") explain nothing anyone can act on: the
  // block is fine, the firmware is old. Said that way instead.
  if (!wired && markedBefore && serialConsole.WIRED_BUILD) {
    for (const id of notes.byBlock.keys()) {
      if (markedBefore.has(id)) continue;
      const name = blocks.find((b) => b.id === id)?.name || 'This block';
      notes.byBlock.set(id, [`${name} cannot run on this board's firmware${build ? ` (build ${build})` : ''}, which only knows a few fixed circuit shapes. Install firmware ${serialConsole.WIRED_BUILD} from the board's dialog and it runs as drawn.`]);
    }
  }
  if (!wired && notes && notes.length > notesBefore && serialConsole.WIRED_BUILD) {
    notes.push(`This board's firmware${build ? ` (build ${build})` : ''} lays a circuit out on its grid, which has room for a few shapes only. Install build ${serialConsole.WIRED_BUILD} or later and every block above runs as drawn.`);
  }
  // The board's socket port for a socket pin block, whichever way it faces.
  const socketPortFor = () => [...socketPinPorts.values()][0] || null;
  for (const block of design.blocks) {
    if (block.type === 'dout' && block.data?.gpio === CAN_OUT_GPIO) {
      block.type = 'can';
      block.data = { ...canPins, bitrate: canBitrate, format: 'string' };
    } else if (block.type === 'din' && block.data?.gpio === CAN_IN_GPIO) {
      block.type = 'can';
      block.data = { ...canPins, bitrate: canBitrate, format: 'string' };
    } else if ((block.type === 'dout' && block.data?.gpio === CNC_OUT_GPIO) || (block.type === 'din' && block.data?.gpio === CNC_IN_GPIO)) {
      block.type = 'cnc';
      block.data = {};
    } else if (block.type === 'dout' && block.data?.gpio === CNC_HOME_GPIO) {
      block.type = 'cnchome';
      block.data = {};
    } else if ((block.type === 'dout' && block.data?.gpio === SOCKET_OUT_GPIO) || (block.type === 'din' && block.data?.gpio === SOCKET_IN_GPIO)) {
      const link = socketLinkOf(socketPortFor());
      block.type = 'socket';
      block.data = { dest: link.dest || 'host', name: link.name || '' };
    }
  }
  // The CNC's settings ride on its `cnc` block — one with nothing wired to
  // `in` or `out` still gets one, since placing the CNC is what sets the
  // machine up.
  if (cncSettings) {
    let target = design.blocks.find((block) => block.type === 'cnc');
    if (!target) {
      const below = design.blocks.reduce((bottom, block) => Math.max(bottom, (block.gy || 0) + (block.h || 1)), 0);
      target = { id: design.nextId || design.blocks.length + 1, type: 'cnc', gx: 0, gy: below + 1, data: {} };
      design.nextId = target.id + 1;
      design.blocks.push(target);
    }
    target.data = { ...target.data, settings: cncSettings };
  }
  return design;
}

// The CNC block's pin ports and the grbl setting each one is (see
// buildPinMappedDesign's CNC section and palette.js's createCncBlock).
const CNC_PIN_PATHS = {
  'X step': 'x/step/pin', 'X dir': 'x/dir/pin', 'Y step': 'y/step/pin', 'Y dir': 'y/dir/pin',
  enable: 'stepper/disable/pin', 'X en': 'x/disable/pin', 'Y en': 'y/disable/pin',
  'X limit': 'x/limit/pin', 'Y limit': 'y/limit/pin',
};

// The named values in a CNC block's subgraph, as grbl's settings-tree
// paths: a Data block `maxrate` in the group `X` is x/maxrate, one
// directly inside the CNC is its own name. A Bool is an on/off setting
// (homing enable) and goes as 1 / 0.
function cncSettingsOf(cnc) {
  const settings = {};
  const valueOf = (block) => {
    const value = propValue(block, 'value', '');
    if (kindOf(block) === 'digital-io') return Number(value) >= 1 || value === true ? 1 : 0;
    return value === true ? 1 : value === false ? 0 : value;
  };
  const isSetting = (block) => kindOf(block) === 'data' || kindOf(block) === 'digital-io';
  for (const child of cnc.children ? cnc.children.blocks.values() : []) {
    if (isSetting(child)) {
      settings[String(child.name).toLowerCase()] = valueOf(child);
      continue;
    }
    if (!child.children) continue;
    const group = String(child.name).toLowerCase();
    for (const leaf of child.children.blocks.values()) {
      if (isSetting(leaf)) settings[`${group}/${String(leaf.name).toLowerCase()}`] = valueOf(leaf);
    }
    if ([...child.children.blocks.values()].some((b) => kindOf(b) === 'cnc-home-axis')) Object.assign(settings, cncHomingCycles(child));
  }
  return settings;
}

// grbl homes in up to six cycles, each the axes that home together
// (homing/cycle0 first). The Homing group's wiring says which: an axis
// whose `home` comes from Homing's own `home` is in the first cycle, one
// whose `home` comes from another axis's `done` in the cycle after that
// axis (after the last of them, if several feed it). An unwired axis is
// not homed. A cycle with no axis is 0.
const CNC_HOMING_CYCLES = 6;
function cncHomingCycles(homing) {
  const blocks = homing.children.blocks;
  const connections = [...homing.children.connections.values()];
  const axes = [...blocks.values()].filter((b) => kindOf(b) === 'cnc-home-axis');
  const level = new Map();
  const visiting = new Set();
  const levelOf = (axis) => {
    if (level.has(axis.id)) return level.get(axis.id);
    if (visiting.has(axis.id)) throw new Error(`Homing: ${axis.name} waits on itself — the axes' done → home wires go round in a circle.`);
    visiting.add(axis.id);
    let at = null;
    for (const conn of connections) {
      if (conn.targetBlockId !== axis.id || logicalName(axis, conn.targetPortId) !== 'home') continue;
      if (conn.sourceBlockId === homing.id) { at = Math.max(at ?? 0, 0); continue; }
      const source = blocks.get(conn.sourceBlockId);
      if (!source || kindOf(source) !== 'cnc-home-axis') continue;
      const before = levelOf(source);
      if (before !== null) at = Math.max(at ?? 0, before + 1);
    }
    visiting.delete(axis.id);
    level.set(axis.id, at);
    return at;
  };
  const cycles = Array.from({ length: CNC_HOMING_CYCLES }, () => '');
  for (const axis of axes) {
    const at = levelOf(axis);
    if (at === null) continue;
    if (at >= CNC_HOMING_CYCLES) throw new Error(`Homing: grbl homes in at most ${CNC_HOMING_CYCLES} steps.`);
    cycles[at] += String(propValue(axis, 'axis', axis.name)).toUpperCase();
  }
  return Object.fromEntries(cycles.map((axesInCycle, i) => [`homing/cycle${i}`, axesInCycle ? [...axesInCycle].sort().join('') : 0]));
}

export function buildExternalDevkitDesign(esp, level) {
  if (!esp || !level) return { blocks: [], nextId: 1 };
  const siblingBlocks = Array.from(level.blocks?.values?.() || []).filter((block) => block.id !== esp.id && !BOARD_KINDS.includes(kindOf(block)));
  return buildPinMappedDesign(esp, siblingBlocks, Array.from(level.connections?.values?.() || []), { face: 'external' });
}

// `level`, when given, is the level the board sits on: what its socket
// pins are wired to out there decides how a socket wired inside compiles
// (see socketLinksFor and mapEndpoint's socket branch).
export function buildInternalDevkitDesign(esp, level = null, { notes = null } = {}) {
  if (!esp) return { blocks: [], nextId: 1 };
  const children = esp.children ? Array.from(esp.children.blocks.values()) : [];
  const childConnections = esp.children ? Array.from(esp.children.connections.values()) : [];
  return buildPinMappedDesign(esp, children, childConnections, { socketLinks: socketLinksFor(esp, level), face: 'internal', notes });
}

// Inside first: a board's own circuit is what you build by entering it, and
// its boundary pins now compile like any other (see buildPinMappedDesign),
// so that face is complete on its own. The exterior face stands in only
// when nothing has been built inside — wiring the board to blocks sitting
// beside it on the parent canvas. Whichever face is used, it's used whole;
// the two are never merged, since each numbers its own blocks from 1.
// `notes` (an array) collects what the drawing has that the design does
// not (see serialConsole.buildMinimalDesign).
export function buildDevkitDesign(esp, level, { notes = null } = {}) {
  const internal = buildInternalDevkitDesign(esp, level, { notes });
  if (internal.blocks.length) return internal;
  return buildExternalDevkitDesign(esp, level);
}

export function devkitSnapshot(esp, level) {
  const snapshotBlock = (block) => ({
    id: block.id, name: block.name, ports: block.ports, logicalPorts: block.logicalPorts,
    props: (block.props || []).filter(p => !['connectionState', 'lastSentSnapshot', 'lastSentDesign', 'deviceDesign', 'firmwareBuild'].includes(p.name)
      && !(kindOf(block) === 'digital-io' && propValue(block, 'direction') !== 'output' && p.name === 'value')),
    children: Array.from(block.children?.blocks?.values?.() || []).map(snapshotBlock),
    connections: Array.from(block.children?.connections?.values?.() || []),
  });
  const siblings = Array.from(level?.blocks?.values?.() || [])
    .filter((block) => block.id !== esp.id && kindOf(block) !== 'esp32-devkit')
    .map(snapshotBlock);
  const levelConnections = Array.from(level?.connections?.values?.() || []).map((cn) => ({
    s: cn.sourceBlockId, sp: cn.sourcePortId, t: cn.targetBlockId, tp: cn.targetPortId,
  }));
  const children = esp.children ? Array.from(esp.children.blocks.values()).map(snapshotBlock) : [];
  const childConnections = esp.children ? Array.from(esp.children.connections.values()).map((cn) => ({
    s: cn.sourceBlockId, sp: cn.sourcePortId, t: cn.targetBlockId, tp: cn.targetPortId,
  })) : [];
  return JSON.stringify({ siblings, levelConnections, children, childConnections });
}

export function summarizeDesign(design) {
  const blocks = Array.isArray(design?.blocks) ? design.blocks : [];
  const pinCount = blocks.filter((b) => b.type === 'din' || b.type === 'dout' || b.type === 'pwmout' || b.type === 'pwmin').length;
  const timerCount = blocks.filter((b) => b.type === 'timer').length;
  const beltCount = blocks.filter((b) => b.type === 'belt' || b.type === 'junc').length;
  return { blockCount: blocks.length, pinCount, timerCount, beltCount };
}

export function isDevkitRunning(esp) {
  return propValue(esp, 'connectionState') === 'connected:running';
}

// A design as the circuit it runs — which block feeds which, with what
// data — so what this compiles and what the board reads back (see
// serialConsole.readDesign) compare as circuits. Layout is not circuit:
// the belts are followed (see designImport.traceDesign) and only the
// connections they make are kept, so a design laid out differently, or
// carrying ids, `nextId` or another key order, is still the same one. A
// block nothing reaches and that reaches nothing — a pin declared on its
// own by an older compiler, an idle CAN block — is not circuit either:
// it runs nothing, and one board's leftover declarations used to keep a
// matching circuit reading as unsaved forever.
//
// The CNC's settings are circuit too, wired or not: they ride on its `cnc`
// block (see buildPinMappedDesign), which nothing has to reach — its pins
// are grbl settings, not wires at run time. Left to the edges alone, a
// changed setting, or a wire from `X step` to IO1, never read as unsaved.
export function canonicalDesign(design) {
  const { blocks, edges } = traceDesign(design);
  const signature = (b) => {
    const data = {};
    for (const k of Object.keys(b.data || {}).sort()) {
      if (k === 'dir') continue;
      data[k] = b.data[k];
    }
    return `${b.type}${stableJson(data)}`;
  };
  const wired = new Set();
  for (const e of edges) {
    wired.add(e.from);
    wired.add(e.to);
  }
  // Each edge names its ends by signature plus a per-signature index, so
  // two identical Data blocks feeding two different pins stay two.
  const index = new Map();
  const nameOf = (b) => {
    if (!index.has(b)) {
      const sig = signature(b);
      const same = blocks.filter((x) => wired.has(x) && signature(x) === sig);
      index.set(b, `${sig}#${same.indexOf(b)}`);
    }
    return index.get(b);
  };
  const lines = edges.map((e) => `${nameOf(e.from)}[${e.output ?? ''}] -> ${nameOf(e.to)}[${e.input ?? ''}]`);
  for (const b of blocks) {
    if (b.type === 'cnc' && b.data?.settings) lines.push(`cnc settings ${stableJson(b.data.settings)}`);
  }
  return JSON.stringify(lines.sort());
}

// JSON with every object's keys sorted, so the same settings compare equal
// whatever order they were written or read back in.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function designsMatch(a, b) {
  return canonicalDesign(a) === canonicalDesign(b);
}

// Anything at all the board could be sent: blocks or wires inside it, or
// a wire to one of its pins from the level it sits in.
// A wire to another board is not one: boards on a bus are wired CAN to
// CAN (canNeighbours.js), and the compiler leaves such wires out (see
// buildExternalDevkitDesign) — counted here, every board on a bus had a
// "circuit", so its device's own was never loaded into it.
export function hasAnyCircuit(esp, level) {
  const isBoard = (id) => {
    const other = level?.blocks?.get?.(id);
    return Boolean(other) && BOARD_KINDS.includes(kindOf(other));
  };
  return Boolean(esp.children?.blocks?.size || esp.children?.connections?.size
    || Array.from(level?.connections?.values?.() || []).some((c) => (c.sourceBlockId === esp.id && !isBoard(c.targetBlockId))
      || (c.targetBlockId === esp.id && !isBoard(c.sourceBlockId))));
}

// "Unsaved" means the design this would send is not the one the device
// was last confirmed to hold (see markDevkitSent) — compared as compiled
// designs, never as snapshots of the blocks themselves: a snapshot changed
// with every migrated prop and every live reading, and the dialog and the
// on-canvas card used to take two different ones, so a freshly saved
// circuit could read as unsaved forever. A circuit that does not compile
// is not on the device either.
export function isDevkitDirty(esp, level) {
  const sent = String(propValue(esp, 'lastSentDesign', '') || '');
  let compiled;
  try {
    compiled = canonicalDesign(buildDevkitDesign(esp, level));
  } catch {
    return true;
  }
  if (!sent) return compiled !== canonicalDesign({ blocks: [] });
  return compiled !== sent;
}

// Records `design` as what the device holds — after a successful save,
// or after reading the device and finding it already matches.
export function markDevkitSent(esp, design) {
  const canonical = canonicalDesign(design);
  const prop = esp.props.find((p) => p.name === 'lastSentDesign');
  if (prop) prop.value = canonical;
  else esp.props.push({ id: `${esp.id}:lastSentDesign`, name: 'lastSentDesign', kind: 'value', value: canonical });
  esp.description = serializeBlockDescription(esp);
}

export function collectEsp32DevkitBlocks(level, out = []) {
  if (!level) return out;
  for (const block of level.blocks.values()) {
    if (kindOf(block) === 'esp32-devkit') out.push({ block, level });
    if (block.children) collectEsp32DevkitBlocks(block.children, out);
  }
  return out;
}

// Every block that is a board with a serial or WiFi link of its own — the
// ESP32 DevKit boards and the CNC module — for the things they share
// (connection state, template refresh, the reconnect card). A circuit
// only ever belongs to a DevKit, so circuit paths keep the narrower
// collectEsp32DevkitBlocks above.
export const BOARD_KINDS = ['esp32-devkit', 'cnc-module'];
export function collectBoardBlocks(level, out = []) {
  if (!level) return out;
  for (const block of level.blocks.values()) {
    if (BOARD_KINDS.includes(kindOf(block))) out.push({ block, level });
    if (block.children) collectBoardBlocks(block.children, out);
  }
  return out;
}
