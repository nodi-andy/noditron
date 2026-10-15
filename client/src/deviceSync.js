// What a board actually holds versus what the block would send — read
// from the device the moment it is known to be running, so "circuit not
// saved" is a fact about the board and not a guess from the last page
// load. Three outcomes: the device already holds this circuit (nothing to
// save), the block is empty and the device is not (the device's circuit
// is loaded into the block, see designImport.js), or the two differ (the
// dialog then offers Save or Load). The blocks a load creates are the
// palette's own, made through its factories with a stand-in for the
// pieces of `nodigraph` those factories touch, so an imported Data or
// Match is exactly what the palette button would have added.
import { serializeBlockDescription, addPort, logicalPortOf } from '/nodigraph/src/model/BlockDescription.js';
import { createConnection } from '/nodigraph/src/model/Connection.js';
import * as serialConsole from './serialConsole.js';
import * as devkitCircuit from './devkitCircuit.js';
import { importDesign } from './designImport.js';
import { createStandaloneDataBlock, createContentRouteBlock, createAndBlock, createOrBlock, createNotBlock, createTimerBlock, createDigitalIOBlock, createCncBlock, createRouteBlock, createDelayBlock } from './palette.js';

const portIdByName = (block, name) => {
  const logical = (block.logicalPorts || []).find((lp) => lp.name === name);
  return logical ? (block.ports || []).find((p) => p.logicalId === logical.id)?.id || null : null;
};

// A CNC block holding `settings` (grbl's settings-tree paths, as the
// design carries them): every named value in its groups set from them,
// and the Homing group's axes wired in the order homing/cycle0..5 give —
// the inverse of devkitCircuit's cncSettingsOf / cncHomingCycles.
function cncBlockWith(make, set, settings) {
  const block = make(createCncBlock);
  for (const group of block.children?.blocks?.values() || []) {
    if (!group.children) continue;
    const name = String(group.name).toLowerCase();
    for (const leaf of group.children.blocks.values()) {
      const key = `${name}/${String(leaf.name).toLowerCase()}`;
      if (!(key in settings)) continue;
      const value = settings[key];
      const isBool = leaf.props.find((p) => p.name === 'noditronKind')?.value === 'digital-io';
      set(leaf, 'value', isBool ? (Number(value) >= 1 || value === true ? 1 : 0) : value);
      leaf.description = serializeBlockDescription(leaf);
    }
    if (name === 'homing') rewireHoming(group, settings);
    group.description = serializeBlockDescription(group);
  }
  return block;
}

function rewireHoming(group, settings) {
  const axes = [...group.children.blocks.values()].filter((b) => b.props.find((p) => p.name === 'noditronKind')?.value === 'cnc-home-axis');
  const axisFor = (letter) => axes.find((a) => String(a.props.find((p) => p.name === 'axis')?.value || a.name).toUpperCase() === letter);
  const homes = new Set(axes.map((a) => portIdByName(a, 'home')));
  for (const [id, conn] of group.children.connections) if (homes.has(conn.targetPortId)) group.children.connections.delete(id);
  let previous = null; // the axes of the last cycle that had any
  for (let i = 0; i < 6; i += 1) {
    const letters = String(settings[`homing/cycle${i}`] || '').toUpperCase().replace(/[^A-Z]/g, '');
    const inCycle = [...letters].map(axisFor).filter(Boolean);
    if (!inCycle.length) continue;
    for (const axis of inCycle) {
      const sources = previous ? previous.map((a) => [a.id, portIdByName(a, 'done')]) : [[group.id, portIdByName(group, 'home')]];
      for (const [sourceBlockId, sourcePortId] of sources) {
        const conn = createConnection({ sourceBlockId, sourcePortId, targetBlockId: axis.id, targetPortId: portIdByName(axis, 'home') });
        group.children.connections.set(conn.id, conn);
      }
    }
    previous = inCycle;
  }
}

function pinMapFor(block) {
  try {
    const map = JSON.parse((block.props || []).find((p) => p.name === 'pinMap')?.value || '[]');
    return Array.isArray(map) ? map : [];
  } catch {
    return [];
  }
}

function setProp(block, name, value) {
  const prop = (block.props || []).find((p) => p.name === name);
  if (prop) prop.value = value;
  else block.props.push({ id: `${block.id}:${name}`, name, kind: 'value', value });
}

export function factoriesFor(nodigraph) {
  // The palette's `finish` adds the new block to the current level,
  // selects it and persists — none of which a block bound for inside a
  // board should do. Only the block itself is wanted.
  const stub = {
    last: null,
    project: { addBlock(block) { stub.last = block; } },
    selection: { select() {} },
    renderLoop: { requestRender() {} },
    persist() {},
    camera: nodigraph.camera,
  };
  const make = (create) => {
    create(stub);
    return stub.last;
  };
  const set = (block, name, value) => {
    const prop = block.props.find((p) => p.name === name);
    if (prop) prop.value = value;
  };
  return {
    data: (value) => {
      const block = make(createStandaloneDataBlock);
      set(block, 'value', value);
      return block;
    },
    match: (routes, outputs) => {
      const block = make(createContentRouteBlock);
      set(block, 'routes', JSON.stringify(routes));
      for (let i = 0; i < outputs; i += 1) {
        const name = `out${i + 1}`;
        const logical = block.logicalPorts.find((lp) => lp.name === name);
        if (logical) {
          delete logical.hidden;
        } else {
          const port = addPort(block, { direction: 'out' });
          logicalPortOf(block, port).name = name;
        }
      }
      return block;
    },
    and: () => make(createAndBlock),
    or: () => make(createOrBlock),
    not: () => make(createNotBlock),
    timer: (onTime, offTime) => {
      const block = make(createTimerBlock);
      for (const kid of block.children?.blocks?.values() || []) {
        if (kid.name === 'T_ON') set(kid, 'value', onTime);
        if (kid.name === 'T_OFF') set(kid, 'value', offTime);
      }
      return block;
    },
    digitalIo: (gpio, direction) => {
      const block = make(createDigitalIOBlock);
      set(block, 'pin', gpio);
      set(block, 'direction', direction);
      block.name = `GPIO${gpio}`;
      return block;
    },
    cnc: (settings) => cncBlockWith(make, set, settings),
    route: () => make(createRouteBlock),
    delay: (ms) => {
      const block = make(createDelayBlock);
      set(block, 'ms', ms);
      return block;
    },
    connection: createConnection,
  };
}

function finishImport(nodigraph, block, result) {
  for (const child of result.created) child.description = serializeBlockDescription(child);
  block.description = serializeBlockDescription(block);
  nodigraph.renderLoop.requestRender();
  nodigraph.persist();
}

function levelOf(nodigraph, block) {
  return devkitCircuit.findContainingLevel(nodigraph.project.rootBlock.children, block.id);
}

function describeImport(result) {
  const wires = result.connections.length;
  let text = `Loaded the device's circuit: ${result.created.length} block(s), ${wires} wire(s).`;
  if (result.skipped.length) text += ` Not supported here and left out: ${result.skipped.join(', ')}.`;
  return text;
}

// Reads the device and settles the block against it. Throws only when the
// device could not be read at all.
export async function reconcileWithDevice(nodigraph, block) {
  const level = levelOf(nodigraph, block);
  // Which design format the board runs decides what this compiles to (see
  // devkitCircuit.boardBuildOf): asked once, when nothing has said yet.
  if (!devkitCircuit.boardBuildOf(block)) await serialConsole.identify(block.id).catch(() => null);
  const onDevice = await serialConsole.readDesign(block.id);
  const deviceBlocks = Array.isArray(onDevice?.blocks) ? onDevice.blocks : [];
  let compiled = null;
  const notes = [];
  try {
    compiled = devkitCircuit.buildDevkitDesign(block, level, { notes });
  } catch {
    compiled = null;
  }
  // Said with every outcome below: "the device holds this circuit" is
  // true of the design, and misleading when the drawing has more in it —
  // as a one-line count here; the full wording, deduped (the compiler
  // repeats itself per chain), goes to the browser console.
  const uniqueNotes = [...new Set(notes)];
  if (uniqueNotes.length) console.info(`Not on the board:\n${uniqueNotes.join('\n')}`);
  const leftOut = uniqueNotes.length ? ` ${uniqueNotes.length} wire(s) left out — details in the browser console.` : '';
  const settle = (deviceDesign) => {
    setProp(block, 'deviceDesign', deviceDesign);
    block.description = serializeBlockDescription(block);
    nodigraph.renderLoop.requestRender();
    nodigraph.persist();
  };
  if (compiled && devkitCircuit.designsMatch(compiled, onDevice)) {
    devkitCircuit.markDevkitSent(block, onDevice);
    settle('');
    return { status: 'in-sync', message: `The device holds this circuit -- nothing to save.${leftOut}` };
  }
  if (!deviceBlocks.length) {
    settle('');
    return { status: 'device-empty', message: 'The device holds no circuit yet.' };
  }
  if (!devkitCircuit.hasAnyCircuit(block, level)) {
    const result = importDesign({ design: onDevice, esp: block, pinMap: pinMapFor(block), factories: factoriesFor(nodigraph), replace: true });
    finishImport(nodigraph, block, result);
    if (result.created.length || result.connections.length) {
      let roundTrips = false;
      try {
        roundTrips = devkitCircuit.designsMatch(devkitCircuit.buildDevkitDesign(block, level), onDevice);
      } catch {
        roundTrips = false;
      }
      if (roundTrips) devkitCircuit.markDevkitSent(block, onDevice);
      settle(roundTrips ? '' : JSON.stringify(onDevice));
      return {
        status: 'loaded',
        message: describeImport(result) + (roundTrips ? '' : ' It does not compile back to the very same layout, so it still reads as unsaved until saved once.'),
      };
    }
  }
  settle(JSON.stringify(onDevice));
  return { status: 'differs', message: `The device holds a different circuit -- save this one to replace it, or load the device's.${leftOut}` };
}

// Replaces whatever is inside the block with the device's circuit — the
// dialog's own explicit "Load circuit from device".
export async function loadFromDevice(nodigraph, block) {
  const level = levelOf(nodigraph, block);
  const onDevice = await serialConsole.readDesign(block.id);
  const result = importDesign({ design: onDevice, esp: block, pinMap: pinMapFor(block), factories: factoriesFor(nodigraph), replace: true });
  finishImport(nodigraph, block, result);
  let roundTrips = false;
  try {
    roundTrips = devkitCircuit.designsMatch(devkitCircuit.buildDevkitDesign(block, level), onDevice);
  } catch {
    roundTrips = false;
  }
  if (roundTrips) devkitCircuit.markDevkitSent(block, onDevice);
  setProp(block, 'deviceDesign', roundTrips ? '' : JSON.stringify(onDevice));
  block.description = serializeBlockDescription(block);
  nodigraph.renderLoop.requestRender();
  nodigraph.persist();
  return { status: 'loaded', message: describeImport(result) };
}
