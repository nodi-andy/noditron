import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The page a board serves of itself opens as that board (client/src/
// boardPage.js): the block for the board at /api/version is found or
// placed (the example diagram cleared), connected to the page's own host,
// settled against the device's circuit, and entered.
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const kindOf = (b) => b.props.find((p) => p.name === 'noditronKind')?.value;

function load(overrides = {}) {
  const calls = { connectWifi: [], identify: [], reconcile: [], disconnect: [], closeConsole: [], placed: [] };
  const deps = {
    serializeBlockDescription: () => '',
    serialFlash: {
      connectWifi: async (id, host) => { calls.connectWifi.push([id, host]); if (overrides.connectFails) throw new Error('no socket'); },
      disconnect: async (id) => { calls.disconnect.push(id); },
    },
    serialConsole: {
      identify: async (id) => { calls.identify.push(id); return overrides.identify || { verified: true, kind: 'logic', node: 'a1d148c4', nodeName: 'esp32-s3' }; },
      closeConsole: (id) => { calls.closeConsole.push(id); },
    },
    reconcileWithDevice: async (nodigraph, block) => { calls.reconcile.push(block.id); return { status: 'loaded', message: 'Loaded the device\'s circuit: 2 block(s), 1 wire(s).' }; },
    collectBoardBlocks: function collect(level, out = []) {
      for (const block of level.blocks.values()) {
        if (kindOf(block) === 'esp32-devkit') out.push({ block, level });
        if (block.children) collect(block.children, out);
      }
      return out;
    },
    resolveModuleByName: async (nodigraph, name) => ({ manifest: { name }, source: { name } }),
    addModuleBlock: (nodigraph, manifest) => {
      const block = {
        id: `board-${manifest.name}`, name: manifest.name === 'esp32-s3-devkit' ? 'esp32-S3' : manifest.name,
        props: [{ name: 'noditronKind', value: 'esp32-devkit' }, { name: 'connectionState', value: 'disconnected' }],
        children: null, geometry: { x: 0, y: 0, width: 200, height: 120 },
      };
      nodigraph.project.getLevel().blocks.set(block.id, block);
      calls.placed.push(manifest.name);
      return [block];
    },
    moduleNameFor: (kind) => (kind === 'cnc' ? 'esp32-cnc' : kind === 'logic' ? 'esp32-s3-devkit' : null),
    scanAndPlaceNeighbours: async (nodigraph, board) => { calls.neighbours.push(board.id); return { nodes: [], neighbours: [], placed: [], wired: [] }; },
    describeNeighbours: (label) => `${label}: nothing else heard on its CAN bus.`,
  };
  calls.neighbours = [];
  const api = new Function(
    ...Object.keys(deps),
    strip(read('../client/src/boardPage.js')) + '\nreturn { whoServesThisPage, moduleNameForBoard, isExampleDiagram, findBoardByNodeId, enterBoard, installBoardPage, installProjectStore };',
  )(...Object.values(deps));
  return { api, calls };
}

// The little of nodigraph's Project the page touches: levels, the path,
// enter/exit, remove.
function fakeProject(rootBlocks = []) {
  const level = (blocks) => ({ blocks: new Map(blocks.map((b) => [b.id, b])), connections: new Map() });
  const project = {
    rootBlock: { children: level(rootBlocks) },
    path: [],
    getLevel() {
      let lvl = this.rootBlock.children;
      for (const id of this.path) lvl = lvl.blocks.get(id).children;
      return lvl;
    },
    getContainerBlock() {
      if (!this.path.length) return null;
      let lvl = this.rootBlock.children;
      let block = null;
      for (const id of this.path) { block = lvl.blocks.get(id); lvl = block.children; }
      return block;
    },
    getBlock(id) { return this.getLevel().blocks.get(id) || null; },
    enterBlock(id) {
      const block = this.getBlock(id);
      if (!block) return false;
      if (!block.children) block.children = level([]);
      this.path = [...this.path, id];
      return true;
    },
    exitBlock() { this.path = this.path.slice(0, -1); },
    removeBlock(id) { this.getLevel().blocks.delete(id); },
  };
  return project;
}

function fakeNodigraph(project) {
  const events = { persisted: 0, rendered: 0, entered: [] };
  const nodigraph = {
    project,
    selection: { clear() {}, select() {} },
    renderLoop: { requestRender() { events.rendered += 1; } },
    persist() { events.persisted += 1; },
    enterBlock(id) { events.entered.push(id); return project.enterBlock(id); },
    events,
  };
  return nodigraph;
}

const example = () => [
  { id: 'a', name: 'Block A', props: [], children: null },
  { id: 'b', name: 'Block B', props: [], children: null },
  { id: 'c', name: 'Block C', props: [], children: null },
];
const version = { name: 'esp32-s3', node: 'a1d148c4', type: 'logic', version: '1.2', build: '20260927e' };
const answering = (info = version) => async () => ({ ok: true, json: async () => info });

test('a page nobody serves as a board is left alone', async () => {
  const { api, calls } = load();
  const nodigraph = fakeNodigraph(fakeProject(example()));
  assert.equal(await api.installBoardPage(nodigraph, { host: 'x', fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await api.installBoardPage(nodigraph, { host: 'x', fetchImpl: async () => ({ ok: true, json: async () => ({ commit: 'abc' }) }) }), null, 'the noditron server answers /api/version too, but is no board');
  assert.equal(nodigraph.project.rootBlock.children.blocks.size, 3);
  assert.equal(calls.placed.length, 0);
  assert.equal(nodigraph.events.persisted, 0);
});

test('the example diagram gives way to the board, connected to the page\'s host, holding its circuit, and entered', async () => {
  const { api, calls } = load();
  const nodigraph = fakeNodigraph(fakeProject(example()));
  const result = await api.installBoardPage(nodigraph, { host: '192.168.0.1', fetchImpl: answering() });
  assert.ok(result?.board);
  assert.deepEqual(calls.placed, ['esp32-s3-devkit']);
  const rootNames = [...nodigraph.project.rootBlock.children.blocks.values()].map((b) => b.name);
  assert.deepEqual(rootNames, ['esp32-S3'], 'Block A, B, C are gone; the board is the diagram');
  const prop = (name) => result.board.props.find((p) => p.name === name)?.value;
  assert.equal(prop('nodeId'), 'a1d148c4');
  assert.equal(prop('connectionState'), 'connected:running');
  assert.deepEqual(calls.connectWifi, [[result.board.id, '192.168.0.1']], 'the link goes to the page\'s own host');
  assert.deepEqual(calls.reconcile, [result.board.id], 'the device\'s circuit is read into the block');
  assert.equal(result.info.reconcile.status, 'loaded');
  assert.deepEqual(calls.neighbours, [result.board.id], 'the board is asked for its CAN neighbours before it is entered');
  assert.deepEqual(nodigraph.project.path, [result.board.id], 'the page opens inside the board');
  assert.deepEqual(nodigraph.events.entered, [result.board.id], 'entered through nodigraph, so camera and breadcrumb follow');
  assert.ok(nodigraph.events.persisted >= 1);
});

test('a board already in the project is found by its node id, reconnected and entered; the user\'s blocks stay', async () => {
  const { api, calls } = load();
  const board = {
    id: 'kept', name: 'my S3', children: { blocks: new Map(), connections: new Map() }, geometry: {},
    props: [{ name: 'noditronKind', value: 'esp32-devkit' }, { name: 'nodeId', value: 'a1d148c4' }, { name: 'connectionState', value: 'disconnected' }],
  };
  const other = { id: 'note', name: 'a note', props: [], children: null };
  const nodigraph = fakeNodigraph(fakeProject([board, other]));
  const result = await api.installBoardPage(nodigraph, { host: '192.168.0.1', fetchImpl: answering() });
  assert.equal(result.board, board);
  assert.equal(calls.placed.length, 0, 'not placed twice');
  assert.equal(nodigraph.project.rootBlock.children.blocks.size, 2, 'nothing removed');
  assert.deepEqual(calls.connectWifi, [['kept', '192.168.0.1']]);
  assert.deepEqual(nodigraph.project.path, ['kept']);
});

test('a reload inside the board stays where it was', async () => {
  const { api } = load();
  const board = {
    id: 'kept', name: 'my S3', geometry: {},
    props: [{ name: 'noditronKind', value: 'esp32-devkit' }, { name: 'nodeId', value: 'a1d148c4' }, { name: 'connectionState', value: 'disconnected' }],
    children: { blocks: new Map([['inner', { id: 'inner', name: 'AND', props: [], children: { blocks: new Map(), connections: new Map() } }]]), connections: new Map() },
  };
  const nodigraph = fakeNodigraph(fakeProject([board]));
  nodigraph.project.path = ['kept', 'inner'];
  await api.installBoardPage(nodigraph, { host: '192.168.0.1', fetchImpl: answering() });
  assert.deepEqual(nodigraph.project.path, ['kept', 'inner']);
  assert.deepEqual(nodigraph.events.entered, []);
});

test('a board that does not answer leaves its block placed, entered and honestly not connected', async () => {
  const { api, calls } = load({ connectFails: true });
  const nodigraph = fakeNodigraph(fakeProject(example()));
  const messages = [];
  const result = await api.installBoardPage(nodigraph, { host: '192.168.0.1', fetchImpl: answering(), log: (m) => messages.push(m) });
  assert.ok(result.board);
  assert.equal(result.info, null);
  assert.equal(result.board.props.find((p) => p.name === 'connectionState').value, 'disconnected');
  assert.deepEqual(calls.reconcile, []);
  assert.deepEqual(calls.disconnect, [result.board.id]);
  // Asked to enter all the same; nodigraph's own rule (noditron's
  // window.nodigraphCanEnter: a board is entered only while it runs) is
  // what then keeps the view outside and opens the board's dialog.
  assert.deepEqual(nodigraph.events.entered, [result.board.id]);
  assert.match(messages.join('\n'), /could not connect to 192\.168\.0\.1: no socket/);
});

test('the module for the board: the S3 over the network, the classic DevKit by name, the CNC by type', () => {
  const { api } = load();
  assert.equal(api.moduleNameForBoard({ type: 'logic', name: 'esp32-s3' }), 'esp32-s3-devkit');
  assert.equal(api.moduleNameForBoard({ type: 'logic', name: 'esp32' }), 'esp32-devkit');
  assert.equal(api.moduleNameForBoard({ type: 'logic', name: 'esp32-devkit' }), 'esp32-devkit');
  assert.equal(api.moduleNameForBoard({ type: 'cnc', name: 'CNC' }), 'esp32-cnc');
  assert.equal(api.moduleNameForBoard({ type: 'other' }), null);
});

test('only the untouched example counts as the example', () => {
  const { api } = load();
  assert.equal(api.isExampleDiagram(fakeProject(example())), true);
  assert.equal(api.isExampleDiagram(fakeProject(example().slice(0, 2))), false);
  const drawn = example();
  drawn[0].children = { blocks: new Map([['x', { id: 'x' }]]), connections: new Map() };
  assert.equal(api.isExampleDiagram(fakeProject(drawn)), false, 'someone drew inside Block A');
  assert.equal(api.isExampleDiagram(fakeProject([])), false);
});

// The project store on a board's page: autosaves batched, the newest
// written after a pause, an explicit Save written at once, each as a
// multipart upload of project.json to /files (see installProjectStore).
function fakeUploads({ ok = true } = {}) {
  const uploads = [];
  const fetchImpl = async (url, init) => {
    const file = init.body.get('file');
    uploads.push({ url, method: init.method, name: file.name, text: await file.text() });
    return { ok };
  };
  return { uploads, fetchImpl };
}

test('autosaves are batched: one upload of the newest project after the pause', async () => {
  const { api } = load();
  const { uploads, fetchImpl } = fakeUploads();
  const target = {};
  const store = api.installProjectStore({ fetchImpl, delayMs: 20, target });
  assert.equal(typeof target.nodigraphSaveProject, 'function', 'store.js hands the shared write over');
  assert.equal(await target.nodigraphSaveProject({ v: 1 }), true);
  assert.equal(await target.nodigraphSaveProject({ v: 2 }), true);
  assert.equal(await target.nodigraphSaveProject({ v: 3 }), true);
  assert.equal(uploads.length, 0, 'nothing sent yet');
  assert.equal(store.pending(), true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(uploads.length, 1);
  assert.deepEqual([uploads[0].url, uploads[0].method, uploads[0].name, JSON.parse(uploads[0].text)], ['/files', 'POST', 'project.json', { v: 3 }]);
  assert.equal(store.pending(), false);
});

test('an explicit Save writes now and says whether the board took it', async () => {
  const { api } = load();
  const good = fakeUploads();
  const target = {};
  api.installProjectStore({ fetchImpl: good.fetchImpl, delayMs: 10000, target });
  target.nodigraphSaveProject({ v: 1 });
  assert.equal(await target.nodigraphSaveProject({ v: 2 }, { flush: true }), true);
  assert.equal(good.uploads.length, 1, 'the pending autosave is folded into the Save');
  assert.deepEqual(JSON.parse(good.uploads[0].text), { v: 2 });
  const bad = fakeUploads({ ok: false });
  const target2 = {};
  api.installProjectStore({ fetchImpl: bad.fetchImpl, delayMs: 10000, target: target2 });
  assert.equal(await target2.nodigraphSaveProject({ v: 1 }, { flush: true }), false, 'a refused upload is reported, not swallowed');
  const down = {};
  api.installProjectStore({ fetchImpl: async () => { throw new Error('offline'); }, delayMs: 10000, target: down });
  assert.equal(await down.nodigraphSaveProject({ v: 1 }, { flush: true }), false);
  assert.equal(await down.nodigraphSaveProject({ v: 2 }, { flush: true }), false, 'and the next Save still tries');
});

test('the board page flushes the store once the block is in place', async () => {
  const { api } = load();
  const { uploads, fetchImpl } = fakeUploads();
  const target = {};
  const store = api.installProjectStore({ fetchImpl, delayMs: 10000, target });
  const nodigraph = fakeNodigraph(fakeProject(example()));
  const persist = nodigraph.persist;
  nodigraph.persist = () => { persist(); target.nodigraphSaveProject({ blocks: [...nodigraph.project.rootBlock.children.blocks.keys()] }); };
  await api.installBoardPage(nodigraph, { host: '192.168.0.1', fetchImpl: answering(), store });
  assert.equal(uploads.length, 1, 'written once, at the end');
  assert.deepEqual(JSON.parse(uploads[0].text), { blocks: ['board-esp32-s3-devkit'] }, 'and it is the project with the board in it');
});
