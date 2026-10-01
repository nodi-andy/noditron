import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// A wire into the board's `socket` pin from inside compiles to the
// firmware's `socket` block, carrying where the socket leads outside (see
// devkitCircuit.socketLinksFor and the socket branch of mapEndpoint):
// another board's node id and name, or 'host' for the browser.

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const kindOf = (b) => (b.props || []).find((p) => p.name === 'noditronKind')?.value;
const serial = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { buildMinimalDesign };')();
const circuit = new Function(
  'serialConsole', 'kindOf', 'serializeBlockDescription', 'traceDesign',
  strip(read('../client/src/devkitCircuit.js')) + '\nreturn { buildDevkitDesign, socketLinksFor };',
)(serial, kindOf, () => '', () => null);

const template = JSON.parse(read('../modules/esp32s3-8io-logic/noditron.module.json')).block.blocks[0];
const cncTemplate = JSON.parse(read('../modules/esp32s3-2io-cnc/noditron.module.json')).block.blocks[0];
const boardPort = (board, label) => board.ports.find((p) => board.logicalPorts.find((lp) => lp.id === p.logicalId)?.name === label).id;

function dataBlock(id, text) {
  return {
    id,
    name: 'Data',
    logicalPorts: [
      { id: `${id}-in`, name: 'in', direction: 'in' },
      { id: `${id}-out`, name: 'out', direction: 'out' },
      { id: `${id}-write`, name: 'write', direction: 'in' },
    ],
    ports: [
      { id: `${id}-in-port`, logicalId: `${id}-in` },
      { id: `${id}-out-port`, logicalId: `${id}-out` },
      { id: `${id}-write-port`, logicalId: `${id}-write` },
    ],
    props: [{ name: 'noditronKind', value: 'data' }, { name: 'value', value: text }],
  };
}

// The S3 with a Data block inside wired to its socket, on a level holding
// whatever `outside` blocks are given and the exterior wires listed.
function scene({ outside = [], wires = [] } = {}) {
  const board = structuredClone(template);
  board.id = 's3';
  const data = dataBlock('d1', 'hellooo');
  board.children = {
    blocks: new Map([[data.id, data]]),
    connections: new Map([['inner', { id: 'inner', sourceBlockId: 'd1', sourcePortId: 'd1-out-port', targetBlockId: 's3', targetPortId: boardPort(board, 'socket') }]]),
  };
  const level = {
    blocks: new Map([[board.id, board], ...outside.map((b) => [b.id, b])]),
    connections: new Map(wires.map((w, i) => [`w${i}`, { id: `w${i}`, ...w }])),
  };
  return { board, level };
}

function cncBlock() {
  const cnc = structuredClone(cncTemplate);
  cnc.id = 'cnc';
  cnc.props.find((p) => p.name === 'nodeId').value = '0dd04644'; // declared by the module, set by identify
  return cnc;
}

test('socket wired to the CNC module compiles to a socket block addressed to that node', () => {
  const cnc = cncBlock();
  const { board, level } = scene({
    outside: [cnc],
    wires: [{ sourceBlockId: 's3', sourcePortId: boardPort(template, 'socket'), targetBlockId: 'cnc', targetPortId: boardPort(cnc, 'socket') }],
  });
  assert.deepEqual([...circuit.socketLinksFor(board, level).values()], [{ far: 'board', dest: '0dd04644', name: 'cnc' }]);
  const design = circuit.buildDevkitDesign(board, level);
  const types = design.blocks.map((b) => b.type);
  assert.ok(types.includes('socket'), `expected a socket block in ${types}`);
  assert.ok(!types.includes('can') && !types.includes('serial'));
  assert.deepEqual(design.blocks.find((b) => b.type === 'socket').data, { dest: '0dd04644', name: 'cnc' });
  // The Data block feeds it: data -> belt -> socket.
  assert.ok(types.includes('data'));
});

test('socket wired to nothing, or to an ordinary block, compiles to a socket block for the host', () => {
  const alone = scene();
  assert.deepEqual([...circuit.socketLinksFor(alone.board, alone.level).values()], [{ far: 'host', dest: 'host', name: '' }]);
  const design = circuit.buildDevkitDesign(alone.board, alone.level);
  assert.deepEqual(design.blocks.find((b) => b.type === 'socket')?.data, { dest: 'host', name: '' });

  const reader = dataBlock('reader', '');
  const wired = scene({
    outside: [reader],
    wires: [{ sourceBlockId: 's3', sourcePortId: boardPort(template, 'socket'), targetBlockId: 'reader', targetPortId: 'reader-in-port' }],
  });
  assert.deepEqual(circuit.buildDevkitDesign(wired.board, wired.level).blocks.find((b) => b.type === 'socket')?.data, { dest: 'host', name: '' });
});

test('a board with only a recorded node name is addressed by that name', () => {
  const cnc = structuredClone(cncTemplate);
  cnc.id = 'cnc';
  cnc.props.find((p) => p.name === 'nodeName').value = 'CNC';
  const { board, level } = scene({
    outside: [cnc],
    wires: [{ sourceBlockId: 's3', sourcePortId: boardPort(template, 'socket'), targetBlockId: 'cnc', targetPortId: boardPort(cnc, 'socket') }],
  });
  assert.deepEqual(circuit.buildDevkitDesign(board, level).blocks.find((b) => b.type === 'socket')?.data, { dest: 'CNC', name: 'CNC' });
});

test('a board without a recorded node id is addressed by name', () => {
  const cnc = structuredClone(cncTemplate);
  cnc.id = 'cnc';
  const { board, level } = scene({
    outside: [cnc],
    wires: [{ sourceBlockId: 's3', sourcePortId: boardPort(template, 'socket'), targetBlockId: 'cnc', targetPortId: boardPort(cnc, 'socket') }],
  });
  assert.deepEqual(circuit.buildDevkitDesign(board, level).blocks.find((b) => b.type === 'socket')?.data, { dest: 'cnc', name: 'cnc' });
});

test('rewiring the socket outside changes what the board would be sent', () => {
  const cnc = cncBlock();
  const before = scene();
  const after = scene({
    outside: [cnc],
    wires: [{ sourceBlockId: 's3', sourcePortId: boardPort(template, 'socket'), targetBlockId: 'cnc', targetPortId: boardPort(cnc, 'socket') }],
  });
  const a = JSON.stringify(circuit.buildDevkitDesign(before.board, before.level).blocks.find((b) => b.type === 'socket')?.data);
  const b = JSON.stringify(circuit.buildDevkitDesign(after.board, after.level).blocks.find((b) => b.type === 'socket')?.data);
  assert.notEqual(a, b);
});
