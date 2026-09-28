import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseNodesOutput } from '../client/src/moduleDiscovery.js';

// The CAN bus, drawn (client/src/canNeighbours.js): a node a board hears
// on its bus gets its module placed beside the board and a CAN wire to
// it; one already placed is only wired; the bridge poll never puts back
// a block that was deleted.
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/^export \{[^}]*\}.*$/gm, '').replace(/export /g, '');

function load() {
  const calls = { placed: [], noted: [], refreshed: 0, shell: [] };
  const deps = {
    generateId: (p) => `${p}_x`,
    serializeBlockDescription: () => '',
    createConnection: ({ sourceBlockId, sourcePortId, targetBlockId, targetPortId }) => ({ id: `${sourcePortId}->${targetPortId}`, sourceBlockId, sourcePortId, targetBlockId, targetPortId }),
    serialConsole: { shell: async (id, line) => { calls.shell.push([id, line]); return { ok: true, lines: ['logic a1d148c4 esp32-s3 v1.2 self', 'cnc 0dd04644 CNC v1.4 seen 1s ago via can', 'logic 1b2c3d4e v1.2 seen 3s ago via wifi'] }; } },
    collectBoardBlocks: function collect(level, out = []) {
      for (const block of level.blocks.values()) {
        if (block.props.some((p) => p.name === 'noditronKind')) out.push({ block, level });
        if (block.children) collect(block.children, out);
      }
      return out;
    },
    findContainingLevel: function find(level, id) {
      if (level.blocks.has(id)) return level;
      for (const block of level.blocks.values()) {
        const hit = block.children && find(block.children, id);
        if (hit) return hit;
      }
      return null;
    },
    addModuleBlock: null,
    resolveModuleByName: null,
    parseNodesOutput,
    canNeighbours: (nodes) => nodes.filter((n) => !n.self && n.via === 'can' && ['cnc', 'logic'].includes(n.type)),
    NODE_TYPE_MODULES: { cnc: 'esp32-cnc', logic: 'esp32-s3-devkit' },
    noteNodes: (id, nodes) => calls.noted.push([id, nodes.length]),
    bridgeForNode: (nodeId) => calls.onBus?.get(nodeId) || null,
    refreshBridgedStates: () => { calls.refreshed += 1; },
  };
  const api = new Function(
    ...Object.keys(deps),
    strip(read('../client/src/canNeighbours.js')) + '\nreturn { placeNeighbours, scanAndPlaceNeighbours, wireCan, canPortOf, findBoardByNodeId, describeNeighbours, pathToLevel, NEIGHBOUR_GAP };',
  )(...Object.values(deps));
  return { api, calls };
}

let n = 0;
function boardBlock(name, { nodeId = '', can = true, kind = 'esp32-devkit' } = {}) {
  const id = `${name}-${(n += 1)}`;
  const block = {
    id, name, props: [{ name: 'noditronKind', value: kind }, { name: 'connectionState', value: 'disconnected' }],
    logicalPorts: [], ports: [], children: null, geometry: { x: 100, y: 50, width: 300, height: 200 },
  };
  if (nodeId) block.props.push({ name: 'nodeId', value: nodeId });
  if (can) {
    block.logicalPorts.push({ id: `${id}:lp-can`, name: 'CAN', direction: 'in' });
    block.ports.push({ id: `${id}:can`, logicalId: `${id}:lp-can`, side: 'right', offset: 20 });
  }
  return block;
}

function fakeNodigraph(rootBlocks, { path = [] } = {}) {
  const level = (blocks) => ({ blocks: new Map(blocks.map((b) => [b.id, b])), connections: new Map() });
  const project = {
    rootBlock: { children: level(rootBlocks) },
    path,
    getLevel() {
      let lvl = this.rootBlock.children;
      for (const id of this.path) lvl = lvl.blocks.get(id).children;
      return lvl;
    },
    hasConnection(a, b) { return [...this.getLevel().connections.values()].some((c) => c.sourcePortId === a && c.targetPortId === b); },
    addConnection(c) { this.getLevel().connections.set(c.id, c); return c; },
  };
  const events = { persisted: 0 };
  return { project, events, persist() { events.persisted += 1; }, renderLoop: { requestRender() {} }, selection: { select() {} } };
}

// Stand-ins for resolveModuleByName + addModuleBlock: the module's block
// into the level being edited (which placeNeighbours switches to the
// board's level for the paste).
function placer(calls, { can = true } = {}) {
  return {
    resolve: async (nodigraph, name) => ({ manifest: { name }, source: { name } }),
    add: (nodigraph, manifest) => {
      const name = manifest.name;
      const block = boardBlock(name === 'esp32-cnc' ? 'cnc' : 'esp32-S3', { can, kind: name === 'esp32-cnc' ? 'cnc-module' : 'esp32-devkit' });
      nodigraph.project.getLevel().blocks.set(block.id, block);
      calls.placed.push(name);
      calls.placedInto = nodigraph.project.path.slice();
      return [block];
    },
  };
}

const nodes = parseNodesOutput(['logic a1d148c4 esp32-s3 v1.2 self', 'cnc 0dd04644 CNC v1.4 seen 1s ago via can', 'logic 1b2c3d4e v1.2 seen 3s ago via wifi']);

test('a CNC heard on CAN is placed beside the board, named, wired CAN to CAN and put online through it', async () => {
  const { api, calls } = load();
  const board = boardBlock('esp32-S3', { nodeId: 'a1d148c4' });
  const nodigraph = fakeNodigraph([board]);
  const result = await api.placeNeighbours(nodigraph, board, nodes, { ...placer(calls) });
  assert.deepEqual(calls.placed, ['esp32-cnc'], 'the WiFi-only node is not placed');
  const cnc = [...nodigraph.project.rootBlock.children.blocks.values()].find((b) => b !== board);
  assert.equal(cnc.name, 'CNC');
  assert.equal(cnc.props.find((p) => p.name === 'nodeId').value, '0dd04644');
  assert.equal(cnc.geometry.x, board.geometry.x + board.geometry.width + api.NEIGHBOUR_GAP, 'to the right of the board');
  assert.equal(nodigraph.project.rootBlock.children.connections.size, 1, 'one CAN wire');
  assert.deepEqual(result.placed, ['CNC']);
  assert.deepEqual(result.wired, ['CNC']);
  assert.equal(calls.refreshed, 1, 'bridged states refreshed, so the CNC reads as running through the S3');
  assert.equal(nodigraph.events.persisted, 1);
});

test('a neighbour that already has a block is only wired, and a second scan changes nothing', async () => {
  const { api, calls } = load();
  const board = boardBlock('esp32-S3', { nodeId: 'a1d148c4' });
  const cnc = boardBlock('CNC', { nodeId: '0dd04644', kind: 'cnc-module' });
  const nodigraph = fakeNodigraph([board, cnc]);
  const first = await api.placeNeighbours(nodigraph, board, nodes, { ...placer(calls) });
  assert.deepEqual(calls.placed, []);
  assert.deepEqual(first.wired, ['CNC']);
  assert.equal(nodigraph.project.rootBlock.children.connections.size, 1);
  const again = await api.placeNeighbours(nodigraph, board, nodes, { ...placer(calls) });
  assert.equal(nodigraph.project.rootBlock.children.connections.size, 1, 'the wire is not doubled');
  assert.deepEqual(again.wired, ['CNC']);
});

test('from inside the board the neighbour still lands on the board\x27s level, wired, and the view stays inside', async () => {
  const { api, calls } = load();
  const board = boardBlock('esp32-S3', { nodeId: 'a1d148c4' });
  board.children = { blocks: new Map(), connections: new Map() };
  const inside = fakeNodigraph([board], { path: [board.id] });
  const result = await api.placeNeighbours(inside, board, nodes, { ...placer(calls) });
  assert.deepEqual(calls.placed, ['esp32-cnc']);
  assert.deepEqual(calls.placedInto, [], 'pasted with the root as the level being edited');
  assert.deepEqual(inside.project.path, [board.id], 'and the view is back inside the board');
  assert.equal(inside.project.rootBlock.children.blocks.size, 2, 'the CNC sits beside the board at the root');
  assert.equal(inside.project.rootBlock.children.connections.size, 1, 'wired at the root, not inside the board');
  assert.equal(board.children.connections.size, 0);
  assert.deepEqual(result.wired, ['CNC']);
});

test('the poll never puts back a block that was offered before', async () => {
  const { api, calls } = load();
  const board = boardBlock('esp32-S3', { nodeId: 'a1d148c4' });
  const offered = new Set();
  const atRoot = fakeNodigraph([board]);
  await api.placeNeighbours(atRoot, board, nodes, { ...placer(calls), offered });
  assert.deepEqual(calls.placed, ['esp32-cnc']);
  assert.ok(offered.has('0dd04644'));
  const placedCnc = [...atRoot.project.rootBlock.children.blocks.values()].find((b) => b !== board);
  atRoot.project.rootBlock.children.blocks.delete(placedCnc.id); // the user deletes it
  await api.placeNeighbours(atRoot, board, nodes, { ...placer(calls), offered });
  assert.deepEqual(calls.placed, ['esp32-cnc'], 'not placed a second time by the poll');
});

test('scanAndPlaceNeighbours asks the board, notes what it heard for the bridge, then places', async () => {
  const { api, calls } = load();
  const board = boardBlock('esp32-S3', { nodeId: 'a1d148c4' });
  const nodigraph = fakeNodigraph([board]);
  const result = await api.scanAndPlaceNeighbours(nodigraph, board, { ...placer(calls), wait: async () => {} });
  // A node was heard over WiFi, so the board is asked a second time.
  assert.deepEqual(calls.shell, [[board.id, 'nodes'], [board.id, 'nodes']]);
  assert.deepEqual(calls.noted, [[board.id, 3], [board.id, 3]]);
  assert.equal(result.nodes.length, 3);
  assert.deepEqual(result.placed, ['CNC']);
  assert.equal(api.describeNeighbours('esp32-S3', result), 'esp32-S3 wired over CAN to CNC.');
  assert.equal(api.describeNeighbours('esp32-S3', { neighbours: [], wired: [] }), 'esp32-S3: nothing else heard on its CAN bus.');
});

test('a board without a CAN pin (the classic DevKit) places its neighbour but cannot wire it', async () => {
  const { api, calls } = load();
  const board = boardBlock('esp32', { nodeId: 'a1d148c4', can: false });
  const nodigraph = fakeNodigraph([board]);
  const result = await api.placeNeighbours(nodigraph, board, nodes, { ...placer(calls) });
  assert.deepEqual(result.placed, ['CNC']);
  assert.deepEqual(result.wired, []);
  assert.equal(nodigraph.project.rootBlock.children.connections.size, 0);
});

// A board on both the bus and the LAN reports whichever hello came last
// (firmware up to 20260927e), so `via wifi` in one reply must not lose a
// neighbour: the registry's memory counts, and the first scan asks twice.
test('a neighbour the registry still has on the bus counts as CAN even when this reply says wifi', async () => {
  const { api, calls } = load();
  const board = boardBlock('esp32-S3', { nodeId: 'a1d148c4' });
  const nodigraph = fakeNodigraph([board]);
  const viaWifi = parseNodesOutput(['cnc 0dd04644 CNC v1.4 seen 0s ago via wifi']);
  const cold = await api.placeNeighbours(nodigraph, board, viaWifi, { ...placer(calls) });
  assert.deepEqual(cold.placed, [], 'never heard on CAN: a WiFi-only node');
  calls.onBus = new Map([['0dd04644', board.id]]);
  const warm = await api.placeNeighbours(nodigraph, board, viaWifi, { ...placer(calls) });
  assert.deepEqual(warm.placed, ['CNC']);
  assert.deepEqual(warm.wired, ['CNC']);
});

test('the first scan asks a second time when a module was heard over WiFi, and takes the CAN answer', async () => {
  const { api, calls } = load();
  const board = boardBlock('esp32-S3', { nodeId: 'a1d148c4' });
  const nodigraph = fakeNodigraph([board]);
  const replies = [
    { ok: true, lines: ['logic a1d148c4 esp32-s3 v1.2 self', 'cnc 0dd04644 CNC v1.4 seen 0s ago via wifi'] },
    { ok: true, lines: ['logic a1d148c4 esp32-s3 v1.2 self', 'cnc 0dd04644 CNC v1.4 seen 0s ago via can'] },
  ];
  const waits = [];
  const shell = async (id, line) => { calls.shell.push([id, line]); return replies.shift(); };
  const result = await api.scanAndPlaceNeighbours(nodigraph, board, { ...placer(calls), shell, wait: async (ms) => { waits.push(ms); } });
  assert.equal(calls.shell.length, 2);
  assert.deepEqual(waits, [1200]);
  assert.deepEqual(result.placed, ['CNC']);
  assert.deepEqual(calls.noted, [[board.id, 2], [board.id, 2]], 'both replies noted for the bridge');
  const once = load();
  const nodigraph2 = fakeNodigraph([boardBlock('esp32-S3', { nodeId: 'a1d148c4' })]);
  const board2 = [...nodigraph2.project.rootBlock.children.blocks.values()][0];
  const shellCan = async (id, line) => { once.calls.shell.push([id, line]); return { ok: true, lines: ['cnc 0dd04644 CNC v1.4 seen 0s ago via can'] }; };
  await once.api.scanAndPlaceNeighbours(nodigraph2, board2, { ...placer(once.calls), shell: shellCan, wait: async () => { throw new Error('no second ask needed'); } });
  assert.equal(once.calls.shell.length, 1, 'a CAN answer is taken at once');
});
