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
import { createStandaloneDataBlock, createContentRouteBlock, createAndBlock, createTimerBlock, createDigitalIOBlock } from './palette.js';

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

function factoriesFor(nodigraph) {
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
  const onDevice = await serialConsole.readDesign(block.id);
  const deviceBlocks = Array.isArray(onDevice?.blocks) ? onDevice.blocks : [];
  let compiled = null;
  try {
    compiled = devkitCircuit.buildDevkitDesign(block, level);
  } catch {
    compiled = null;
  }
  const settle = (deviceDesign) => {
    setProp(block, 'deviceDesign', deviceDesign);
    block.description = serializeBlockDescription(block);
    nodigraph.renderLoop.requestRender();
    nodigraph.persist();
  };
  if (compiled && devkitCircuit.designsMatch(compiled, onDevice)) {
    devkitCircuit.markDevkitSent(block, onDevice);
    settle('');
    return { status: 'in-sync', message: 'The device holds this circuit -- nothing to save.' };
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
  return { status: 'differs', message: "The device holds a different circuit -- save this one to replace it, or load the device's." };
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
