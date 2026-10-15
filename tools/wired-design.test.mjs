import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { traceDesign, importDesign } from '../client/src/designImport.js';
import { startRuntime, setChildOutput, clearChildOutputs, getLastResult } from '../client/src/runtime.js';

// A board whose firmware runs wires (build 20261011a and later) is sent the
// circuit as drawn: one firmware block per drawn block, one wire per wire
// (serialConsole.buildWiredDesign). The joystick circuit below is the one
// the grid layouts could not hold — a Gate's sel from an OR of two pins the
// Match chains use too — and lost its whole jog loop to.

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const kindOf = (b) => b.props.find((p) => p.name === 'noditronKind')?.value;
const serial = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { buildMinimalDesign, buildWiredDesign, runsWires, WIRED_BUILD, firmwareBuildOf };')();
const circuit = new Function(
  'serialConsole', 'kindOf', 'serializeBlockDescription', 'traceDesign',
  strip(read('../client/src/devkitCircuit.js')) + '\nreturn { buildInternalDevkitDesign, canonicalDesign, designsMatch };',
)(serial, kindOf, () => '', traceDesign);

const manifest = JSON.parse(read('../modules/esp32s3-2io-logic/noditron.module.json'));
const template = manifest.block.blocks[0];
const pinMap = JSON.parse(template.props.find((p) => p.name === 'pinMap').value);

function freshBoard(build = serial.WIRED_BUILD) {
  const board = structuredClone(template);
  board.children = { blocks: new Map(), connections: new Map() };
  board.props.push({ name: 'firmwareBuild', value: build });
  return board;
}
const boardPort = (board, label) => board.ports.find((p) => board.logicalPorts.find((lp) => lp.id === p.logicalId)?.name === label).id;

let n = 0;
function stubFactories() {
  const make = (name, kind, props, ports) => {
    const block = {
      id: `b${(n += 1)}`, name, logicalPorts: [], ports: [], children: null,
      props: [{ name: 'noditronKind', value: kind }, ...props.map(([pn, value]) => ({ name: pn, value }))],
      geometry: { x: n * 10, y: n * 5, width: 160, height: 60 },
    };
    for (const [pn, dir] of ports) {
      const id = `lp${(n += 1)}`;
      block.logicalPorts.push({ id, name: pn, direction: dir });
      block.ports.push({ id: `p${n}`, logicalId: id, side: dir === 'in' ? 'left' : 'right', offset: 20 });
    }
    return block;
  };
  return {
    data: (value) => make('Data', 'data', [['value', value]], [['in', 'in'], ['write', 'in'], ['out', 'out']]),
    match: (routes, outputs) => make('Match', 'croute', [['routes', JSON.stringify(routes)]], [['in', 'in'], ...Array.from({ length: Math.max(outputs, 4) }, (_, i) => [`out${i + 1}`, 'out'])]),
    and: () => make('AND', 'and', [], [['a', 'in'], ['b', 'in'], ['out', 'out']]),
    or: () => make('OR', 'or', [], [['a', 'in'], ['b', 'in'], ['out', 'out']]),
    not: () => make('NOT', 'not', [], [['in', 'in'], ['out', 'out']]),
    timer: () => make('Timer', 'timer', [], [['out', 'out']]),
    digitalIo: (gpio, direction) => make(`GPIO${gpio}`, 'digital-io', [['pin', gpio], ['direction', direction], ['value', 0]], [['in', 'in'], ['out', 'out']]),
    route: () => make('Gate', 'route', [], [['sel', 'in'], ['in', 'in'], ['out1', 'out'], ['out2', 'out'], ['out3', 'out'], ['out4', 'out']]),
    delay: (ms) => make('Delay', 'delay', [['ms', ms]], [['in', 'in'], ['out', 'out']]),
    connection: ({ sourceBlockId, sourcePortId, targetBlockId, targetPortId }) => ({ id: `c${(n += 1)}`, sourceBlockId, sourcePortId, targetBlockId, targetPortId }),
  };
}

function build(draw, buildId) {
  const board = freshBoard(buildId);
  const f = stubFactories();
  const add = (block) => { board.children.blocks.set(block.id, block); return block; };
  const end = (e) => (typeof e === 'string'
    ? { blockId: board.id, portId: boardPort(board, e) }
    : { blockId: e[0].id, portId: e[0].ports.find((p) => e[0].logicalPorts.find((lp) => lp.id === p.logicalId).name === e[1]).id });
  const wire = (from, to) => {
    const c = f.connection({ sourceBlockId: end(from).blockId, sourcePortId: end(from).portId, targetBlockId: end(to).blockId, targetPortId: end(to).portId });
    board.children.connections.set(c.id, c);
  };
  const named = {};
  draw({ add, wire, f, named });
  return { board, named };
}

// The joystick: IO2 starts and stops a plus jog, IO1 a minus one; while
// either is held (OR -> Gate sel), every "x jogging ..." the CNC answers
// comes back 100 ms later as "x jog continue".
function joystick({ writeToo = false } = {}, buildId) {
  return build(({ add, wire, f, named }) => {
    const or = (named.or = add(f.or()));
    const gate = (named.gate = add(f.route()));
    const jogging = add(f.match(['x jogging plus', 'x jogging minus'], 2));
    const delay = (named.delay = add(f.delay(100)));
    const cont = (named.cont = add(f.data('x jog continue')));
    wire('IO1', [or, 'a']);
    wire('IO2', [or, 'b']);
    wire([or, 'out'], [gate, 'sel']);
    wire('CAN', [jogging, 'in']);
    wire([jogging, 'out1'], [delay, 'in']);
    wire([jogging, 'out2'], [delay, 'in']);
    wire([delay, 'out'], [gate, 'in']);
    wire([gate, 'out2'], [cont, 'in']);
    wire([cont, 'out'], 'CAN');
    for (const [pin, text] of [['IO2', 'x jog start plus'], ['IO1', 'x jog start minus']]) {
      const match = add(f.match(['1', '0'], 2));
      const start = add(f.data(text));
      const stop = add(f.data('x jog stop'));
      if (pin === 'IO2') named.start = start;
      wire(pin, [match, 'in']);
      wire([match, 'out1'], [start, 'in']);
      if (writeToo) wire([match, 'out1'], [start, 'write']);
      wire([match, 'out2'], [stop, 'in']);
      wire([start, 'out'], 'CAN');
      wire([stop, 'out'], 'CAN');
    }
  }, buildId);
}

const byType = (design, type) => design.blocks.filter((b) => b.type === type);
const fw = (design, ref) => design.blocks.find((b) => b.ref === ref);

test('the whole joystick reaches a wired board, nothing left out', () => {
  const { board, named } = joystick();
  const notes = [];
  const design = circuit.buildInternalDevkitDesign(board, null, { notes });
  assert.deepEqual(notes, []);
  assert.equal(design.format, 'wires');
  assert.equal(byType(design, 'belt').length, 0, 'no grid');
  assert.equal(byType(design, 'or').length, 1);
  assert.equal(byType(design, 'route').length, 1);
  assert.equal(byType(design, 'timer').filter((b) => b.data.mode === 'delay').length, 1);
  assert.equal(byType(design, 'data').length, 5);
  assert.deepEqual(byType(design, 'din').map((b) => b.data.gpio).sort(), [1, 2], 'one din per pin, however many blocks it feeds');

  const has = (from, sp, to, dp) => design.wires.some((w) => w[0] === from.id && w[1] === sp && w[2] === to.id && w[3] === dp);
  const or = fw(design, named.or.id);
  const gate = fw(design, named.gate.id);
  assert.ok(has(or, 0, gate, 0), 'OR -> Gate sel (input 0)');
  assert.ok(has(fw(design, named.delay.id), 0, gate, 1), 'Delay -> Gate in (input 1)');
  assert.ok(has(gate, 1, fw(design, named.cont.id), 0), 'Gate out2 (output 1) -> Data trigger');
  const io2 = byType(design, 'din').find((b) => b.data.gpio === 2);
  assert.ok(has(io2, 0, or, 1), 'IO2 -> OR b (input 1)');
  assert.equal(gate.h, 5, 'a Gate row per output plus its sel');
  assert.deepEqual(byType(design, 'can').every((b) => b.data.tx === 15 && b.data.rx === 16), true, 'the 2IO board\'s transceiver');
});

test('a wired design reads back into the same circuit, where it was drawn', () => {
  const { board } = joystick();
  const design = circuit.buildInternalDevkitDesign(board);
  const empty = freshBoard();
  const result = importDesign({ design: JSON.parse(JSON.stringify(design)), esp: empty, pinMap, factories: stubFactories(), replace: true });
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.created.map(kindOf).sort(), ['croute', 'croute', 'croute', 'data', 'data', 'data', 'data', 'data', 'delay', 'or', 'route']);
  const again = circuit.buildInternalDevkitDesign(empty);
  assert.ok(circuit.designsMatch(again, design), 'compiles back to the same circuit');
  const or = result.created.find((b) => kindOf(b) === 'or');
  const drawn = [...board.children.blocks.values()].find((b) => kindOf(b) === 'or');
  assert.deepEqual([or.geometry.x, or.geometry.y], [drawn.geometry.x, drawn.geometry.y], 'kept where it was drawn');
});

test('a Data triggered and written by the same output is called out, on that block', () => {
  const { board, named } = joystick({ writeToo: true });
  const notes = [];
  notes.byBlock = new Map();
  circuit.buildInternalDevkitDesign(board, null, { notes });
  assert.equal(notes.length, 2, 'both start Datas are wired that way');
  assert.match(notes[0], /second wire from Match.out1/);
  assert.equal(notes.byBlock.size, 2);
  assert.ok(notes.byBlock.has(named.start.id));
});

test('a board on older firmware keeps the grid layouts and is told what a newer one would run', () => {
  const { board } = joystick({}, '20260930r');
  const notes = [];
  const design = circuit.buildInternalDevkitDesign(board, null, { notes });
  assert.notEqual(design.format, 'wires');
  assert.ok(notes.some((line) => /Gate/.test(line)), 'the Gate is still left out there');
  assert.match(notes.at(-1), /build 20260930r.*Install build 20261011a/);
});

test('inside a board the firmware runs, a block reads its inputs off the reported values', async () => {
  const f = stubFactories();
  const or = f.or();
  const gate = f.route();
  const board = { id: 'board', props: [], logicalPorts: [], ports: [], children: { blocks: new Map([[or.id, or], [gate.id, gate]]), connections: new Map() } };
  const outPin = or.ports.find((p) => or.logicalPorts.find((l) => l.id === p.logicalId).name === 'out').id;
  const selPin = gate.ports.find((p) => gate.logicalPorts.find((l) => l.id === p.logicalId).name === 'sel').id;
  board.children.connections.set('w', { id: 'w', sourceBlockId: or.id, sourcePortId: outPin, targetBlockId: gate.id, targetPortId: selPin });
  const root = { id: 'root', children: { blocks: new Map([[board.id, board]]), connections: new Map() } };
  const nodigraph = { project: { rootBlock: root, getContainerBlock: () => board } };
  const stop = startRuntime(nodigraph, () => {}, 20, (container) => {
    if (container !== board) return undefined;
    setChildOutput(board.id, or.id, outPin, true);
    return false;
  });
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(getLastResult().inputsByBlock.get(gate.id), { sel: true }, 'the Gate sees the OR the board reported');
    clearChildOutputs(board.id);
  } finally {
    stop();
  }
});

test('a second block of a name gets a number; boards and named parts keep theirs', () => {
  const { uniquifyNames } = new Function('serializeBlockDescription', strip(read('../client/src/uniqueNames.js')) + '\nreturn { uniquifyNames };')(() => '');
  const blk = (id, name, kind, children = null) => ({ id, name, props: kind ? [{ name: 'noditronKind', value: kind }] : [], children });
  const level = (...blocks) => ({ blocks: new Map(blocks.map((b) => [b.id, b])) });
  const timer = blk('t', 'Timer', 'timer', level(blk('on', 'T_ON'), blk('on2', 'T_ON')));
  const inside = level(blk('m1', 'Match', 'croute'), blk('m2', 'Match', 'croute'), blk('m3', 'Match 2', 'croute'), blk('m4', 'Match', 'croute'), timer);
  const root = level(blk('j', 'joystick', 'esp32-devkit', inside), blk('d', 'joystick', 'data'));
  assert.equal(uniquifyNames(root), true);
  assert.deepEqual([...inside.blocks.values()].map((b) => b.name), ['Match', 'Match 3', 'Match 2', 'Match 4', 'Timer']);
  assert.equal(root.blocks.get('j').name, 'joystick', 'the board keeps its name');
  assert.equal(root.blocks.get('d').name, 'joystick 2', 'a block named like the board gives way');
  assert.deepEqual([...timer.children.blocks.values()].map((b) => b.name), ['T_ON', 'T_ON'], 'named parts untouched');
  assert.equal(uniquifyNames(root), false, 'nothing to do the second time');
});

test('an OR inside a board shows what its pins make of it, before the board says anything', async () => {
  const f = stubFactories();
  const or = f.or();
  const gate = f.route();
  const pinOf = (b, name) => b.ports.find((p) => b.logicalPorts.find((l) => l.id === p.logicalId).name === name).id;
  const board = { id: 'board2', props: [], logicalPorts: [{ id: 'io2', name: 'IO2', direction: 'in' }], ports: [{ id: 'pIO2', logicalId: 'io2' }], children: { blocks: new Map([[or.id, or], [gate.id, gate]]), connections: new Map() } };
  board.children.connections.set('w1', { id: 'w1', sourceBlockId: board.id, sourcePortId: 'pIO2', targetBlockId: or.id, targetPortId: pinOf(or, 'b') });
  board.children.connections.set('w2', { id: 'w2', sourceBlockId: or.id, sourcePortId: pinOf(or, 'out'), targetBlockId: gate.id, targetPortId: pinOf(gate, 'sel') });
  const root = { id: 'root2', children: { blocks: new Map([[board.id, board]]), connections: new Map() } };
  const { setBoundaryInput } = await import('../client/src/runtime.js');
  const nodigraph = { project: { rootBlock: root, getContainerBlock: () => board } };
  const stop = startRuntime(nodigraph, () => {}, 20, (container) => {
    if (container !== board) return undefined;
    setBoundaryInput(board.id, 'pIO2', true);
    return false;
  });
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(getLastResult().outputsByBlock.get(or.id), { out: true }, 'IO2 pressed: OR is 1');
    assert.deepEqual(getLastResult().inputsByBlock.get(gate.id), { sel: true }, 'and the Gate sees it as its sel');
  } finally {
    stop();
  }
});
