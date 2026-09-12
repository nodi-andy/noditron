import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { kindOf } from './runtime.js';
import * as serialConsole from './serialConsole.js';

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
  const gpioByPortName = new Map(
    pinMapFor(esp)
      .filter((pin) => pin.gpio !== null && pin.gpio !== undefined)
      .map((pin) => [pin.label, Number(pin.gpio)]),
  );
  const syntheticPins = new Map();

  function syntheticPinBlock(gpio, direction) {
    const key = `${direction}:${gpio}`;
    if (syntheticPins.has(key)) return syntheticPins.get(key);
    const block = {
      id: `${esp.id}:${key}`,
      name: `GPIO${gpio}`,
      logicalPorts: [{ id: `${esp.id}:${key}:io`, name: 'value', direction: direction === 'output' ? 'in' : 'out' }],
      ports: [{ id: `${esp.id}:${key}:port`, logicalId: `${esp.id}:${key}:io`, side: direction === 'output' ? 'left' : 'right', offset: 20, manualOffset: true }],
      props: [
        { id: `${esp.id}:${key}:pin`, name: 'pin', kind: 'value', value: gpio },
        { id: `${esp.id}:${key}:dir`, name: 'direction', kind: 'value', value: direction },
        { id: `${esp.id}:${key}:value`, name: 'value', kind: 'range', min: 0, max: 1, value: 0 },
        { id: `${esp.id}:${key}:kind`, name: 'noditronKind', kind: 'value', value: 'digital-io' },
      ],
    };
    syntheticPins.set(key, block);
    return block;
  }

  function mapEndpoint(blockId, portId, isTarget) {
    if (blockId !== esp.id) return { blockId, portId };
    const portName = logicalName(esp, portId);
    const gpio = gpioByPortName.get(portName);
    if (gpio === undefined) return null;
    const pin = syntheticPinBlock(gpio, isTarget ? 'output' : 'input');
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

  return serialConsole.buildMinimalDesign([...blocks, ...syntheticPins.values()], mapped);
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
  const siblings = Array.from(level?.blocks?.values?.() || [])
    .filter((block) => block.id !== esp.id)
    .map((block) => ({ id: block.id, props: block.props, ports: block.ports, logicalPorts: block.logicalPorts }));
  const levelConnections = Array.from(level?.connections?.values?.() || []).map((cn) => ({
    s: cn.sourceBlockId, sp: cn.sourcePortId, t: cn.targetBlockId, tp: cn.targetPortId,
  }));
  const children = esp.children ? Array.from(esp.children.blocks.values()).map((block) => ({ id: block.id, props: block.props })) : [];
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

export function markDevkitSent(esp, snapshot) {
  const lastSentProp = esp.props.find((p) => p.name === 'lastSentSnapshot');
  if (lastSentProp) lastSentProp.value = snapshot;
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
