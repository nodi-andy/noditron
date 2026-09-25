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
  aliases.set('G2', 'CAN Out'); aliases.set('G3', 'CAN In');
  aliases.set('CAN TX', 'CAN Out'); aliases.set('CAN RX', 'CAN In');
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
function buildPinMappedDesign(esp, blocks, connections) {
  const allPinsByPortName = new Map(pinMapFor(esp).map((pin) => [pin.label, pin]));
  const pinsByPortName = new Map(
    pinMapFor(esp)
      .filter((pin) => pin.gpio !== null && pin.gpio !== undefined)
      .map((pin) => [pin.label, pin]),
  );
  const syntheticPins = new Map();
  const CAN_OUT_GPIO = 2000;
  const CAN_IN_GPIO = 2001;
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
    if (boardPin?.role === 'can-out') {
      if (!isTarget) throw new Error('CAN Out only accepts data to transmit.');
      const pin = syntheticPinBlock({ label: 'CAN Out', gpio: CAN_OUT_GPIO }, 'output');
      return { blockId: pin.id, portId: pin.ports[0].id };
    }
    if (boardPin?.role === 'can-in') {
      if (isTarget) throw new Error('CAN In only provides received data.');
      const pin = syntheticPinBlock({ label: 'CAN In', gpio: CAN_IN_GPIO }, 'input');
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
    if (mappedPin.reserved || (isTarget && mappedPin.inputOnly) || (!isTarget && mappedPin.outputOnly)) {
      throw new Error(`${portName} cannot be used as a digital ${isTarget ? 'output' : 'input'}.`);
    }
    const pin = syntheticPinBlock(mappedPin, isTarget ? 'output' : 'input');
    return { blockId: pin.id, portId: pin.ports[0].id };
  }

  const mapped = [];
  for (const conn of connections) {
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

  const design = serialConsole.buildMinimalDesign([...blocks, ...syntheticPins.values(), ...(usesUsb ? [usbTarget] : [])], mapped);
  for (const block of design.blocks) {
    if (block.type === 'dout' && block.data?.gpio === CAN_OUT_GPIO) {
      block.type = 'can';
      block.data = { tx: 2, rx: 3, bitrate: canBitrate, format: 'string' };
    } else if (block.type === 'din' && block.data?.gpio === CAN_IN_GPIO) {
      block.type = 'can';
      block.data = { tx: 2, rx: 3, bitrate: canBitrate, format: 'string' };
    }
  }
  return design;
}

export function buildExternalDevkitDesign(esp, level) {
  if (!esp || !level) return { blocks: [], nextId: 1 };
  const siblingBlocks = Array.from(level.blocks?.values?.() || []).filter((block) => block.id !== esp.id && kindOf(block) !== 'esp32-devkit');
  return buildPinMappedDesign(esp, siblingBlocks, Array.from(level.connections?.values?.() || []));
}

export function buildInternalDevkitDesign(esp) {
  if (!esp) return { blocks: [], nextId: 1 };
  const children = esp.children ? Array.from(esp.children.blocks.values()) : [];
  const childConnections = esp.children ? Array.from(esp.children.connections.values()) : [];
  return buildPinMappedDesign(esp, children, childConnections);
}

// Inside first: a board's own circuit is what you build by entering it, and
// its boundary pins now compile like any other (see buildPinMappedDesign),
// so that face is complete on its own. The exterior face stands in only
// when nothing has been built inside — wiring the board to blocks sitting
// beside it on the parent canvas. Whichever face is used, it's used whole;
// the two are never merged, since each numbers its own blocks from 1.
export function buildDevkitDesign(esp, level) {
  const internal = buildInternalDevkitDesign(esp);
  if (internal.blocks.length) return internal;
  return buildExternalDevkitDesign(esp, level);
}

export function devkitSnapshot(esp, level) {
  const snapshotBlock = (block) => ({
    id: block.id, name: block.name, ports: block.ports, logicalPorts: block.logicalPorts,
    props: (block.props || []).filter(p => !['connectionState', 'lastSentSnapshot', 'lastSentDesign', 'deviceDesign'].includes(p.name)
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
export function canonicalDesign(design) {
  const { blocks, edges } = traceDesign(design);
  const signature = (b) => {
    const data = {};
    for (const k of Object.keys(b.data || {}).sort()) {
      if (k === 'dir') continue;
      data[k] = b.data[k];
    }
    return `${b.type}${JSON.stringify(data)}`;
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
  const lines = edges.map((e) => `${nameOf(e.from)}[${e.output ?? ''}] -> ${nameOf(e.to)}[${e.input ?? ''}]`).sort();
  return JSON.stringify(lines);
}

export function designsMatch(a, b) {
  return canonicalDesign(a) === canonicalDesign(b);
}

// Anything at all the board could be sent: blocks or wires inside it, or
// a wire to one of its pins from the level it sits in.
export function hasAnyCircuit(esp, level) {
  return Boolean(esp.children?.blocks?.size || esp.children?.connections?.size
    || Array.from(level?.connections?.values?.() || []).some((c) => c.sourceBlockId === esp.id || c.targetBlockId === esp.id));
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
