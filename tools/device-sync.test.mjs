import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { traceDesign, importDesign } from '../client/src/designImport.js';

// What a board holds is read back into its block (designImport.js) and
// compared as a compiled design (devkitCircuit.canonicalDesign). The
// round trip is the contract: a circuit compiled, loaded from that
// design into an empty board, and compiled again is the same design.

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const kindOf = (b) => b.props.find((p) => p.name === 'noditronKind')?.value;
const serial = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { buildMinimalDesign };')();
const circuit = new Function(
  'serialConsole', 'kindOf', 'serializeBlockDescription', 'traceDesign',
  strip(read('../client/src/devkitCircuit.js')) + '\nreturn { buildInternalDevkitDesign, canonicalDesign, designsMatch, isDevkitDirty, markDevkitSent, hasAnyCircuit };',
)(serial, kindOf, () => '', traceDesign);

const manifest = JSON.parse(read('../modules/esp32s3-8io-logic/noditron.module.json'));
const template = manifest.block.blocks[0];
const pinMap = JSON.parse(template.props.find((p) => p.name === 'pinMap').value);

function freshBoard() {
  const board = structuredClone(template);
  board.children = { blocks: new Map(), connections: new Map() };
  return board;
}
const boardPort = (board, label) => board.ports.find((p) => board.logicalPorts.find((lp) => lp.id === p.logicalId)?.name === label).id;

// Stand-ins for the palette's blocks: only what the compiler reads.
let n = 0;
function stubFactories() {
  const addPort = (block, name, direction) => {
    const id = `lp${(n += 1)}`;
    block.logicalPorts.push({ id, name, direction });
    block.ports.push({ id: `p${n}`, logicalId: id, side: direction === 'in' ? 'left' : 'right', offset: 20 });
  };
  const make = (name, kind, props, ports) => {
    const block = {
      id: `b${(n += 1)}`, name, logicalPorts: [], ports: [], children: null,
      props: [{ name: 'noditronKind', value: kind }, ...props.map(([pn, value]) => ({ name: pn, value }))],
      geometry: { x: 0, y: 0, width: 160, height: 60 },
    };
    for (const [pn, dir] of ports) addPort(block, pn, dir);
    return block;
  };
  return {
    data: (value) => make('Data', 'data', [['value', value]], [['in', 'in'], ['out', 'out']]),
    match: (routes, outputs) => make('Match', 'croute', [['routes', JSON.stringify(routes)]], [['in', 'in'], ...Array.from({ length: outputs }, (_, i) => [`out${i + 1}`, 'out'])]),
    and: () => make('AND', 'and', [], [['a', 'in'], ['b', 'in'], ['out', 'out']]),
    timer: (onTime, offTime) => {
      const t = make('Timer', 'timer', [], [['out', 'out']]);
      t.children = { blocks: new Map([['on', { id: 'on', name: 'T_ON', props: [{ name: 'value', value: onTime }] }], ['off', { id: 'off', name: 'T_OFF', props: [{ name: 'value', value: offTime }] }]]), connections: new Map() };
      return t;
    },
    digitalIo: (gpio, direction) => make(`GPIO${gpio}`, 'digital-io', [['pin', gpio], ['direction', direction], ['value', 0]], [['in', 'in'], ['out', 'out']]),
    route: () => make('Gate', 'route', [], [['sel', 'in'], ['in', 'in'], ['out1', 'out'], ['out2', 'out'], ['out3', 'out'], ['out4', 'out']]),
    delay: (ms) => make('Delay', 'delay', [['ms', ms]], [['in', 'in'], ['out', 'out']]),
    connection: ({ sourceBlockId, sourcePortId, targetBlockId, targetPortId }) => ({ id: `c${(n += 1)}`, sourceBlockId, sourcePortId, targetBlockId, targetPortId }),
  };
}

// Builds a circuit inside a fresh board: `add` places a child, `wire`
// joins two ends, each end a [block, portName] or a board pin label.
function build(draw) {
  const board = freshBoard();
  const f = stubFactories();
  const add = (block) => { board.children.blocks.set(block.id, block); return block; };
  const end = (e) => (typeof e === 'string'
    ? { blockId: board.id, portId: boardPort(board, e) }
    : { blockId: e[0].id, portId: e[0].ports.find((p) => e[0].logicalPorts.find((lp) => lp.id === p.logicalId).name === e[1]).id });
  const wire = (from, to) => {
    const c = f.connection({ sourceBlockId: end(from).blockId, sourcePortId: end(from).portId, targetBlockId: end(to).blockId, targetPortId: end(to).portId });
    board.children.connections.set(c.id, c);
  };
  draw({ add, wire, f });
  return board;
}

function roundTrip(board) {
  const design = circuit.buildInternalDevkitDesign(board);
  assert.ok(design.blocks.length, 'the circuit compiles to something');
  const empty = freshBoard();
  const result = importDesign({ design, esp: empty, pinMap, factories: stubFactories(), replace: true });
  const again = circuit.buildInternalDevkitDesign(empty);
  assert.equal(circuit.canonicalDesign(again), circuit.canonicalDesign(design));
  return { design, result, empty };
}

test('a belt run is traced from the block it leaves to the block it lands in', () => {
  const { edges } = traceDesign({ blocks: [
    { id: 1, type: 'din', gx: 0, gy: 0, data: { gpio: 4 } },
    { id: 2, type: 'belt', gx: 2, gy: 0, data: { dir: 'E' } },
    { id: 3, type: 'dout', gx: 3, gy: 0, data: { exio: 1 } },
  ] });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from.type, 'din');
  assert.equal(edges[0].to.type, 'dout');
});

test('DI to DO on the board pins comes back as the same design', () => {
  const { result } = roundTrip(build(({ wire }) => wire('DI1', 'DO1')));
  assert.equal(result.created.length, 0, 'board pins need no child blocks');
  assert.equal(result.connections.length, 1);
});

test('a Match chain into CAN comes back with its routes, Data values and rows', () => {
  const board = build(({ add, wire, f }) => {
    const match = add(f.match(['1', '0'], 2));
    const on = add(f.data('X100'));
    const off = add(f.data('X0'));
    wire('DI1', [match, 'in']);
    wire([match, 'out1'], [on, 'in']);
    wire([match, 'out2'], [off, 'in']);
    wire([on, 'out'], 'CAN');
    wire([off, 'out'], 'CAN');
  });
  const { result, empty } = roundTrip(board);
  assert.deepEqual(result.created.map((b) => kindOf(b)).sort(), ['croute', 'data', 'data']);
  const match = result.created.find((b) => kindOf(b) === 'croute');
  assert.equal(match.props.find((p) => p.name === 'routes').value, '["1","0"]');
  assert.ok(empty.children.connections.size >= 5);
});

test('a constant sent at boot comes back as Data straight into its pin, with no boot block', () => {
  const { result } = roundTrip(build(({ add, wire, f }) => wire([add(f.data('$X')), 'out'], 'DO2')));
  assert.deepEqual(result.created.map((b) => kindOf(b)), ['data']);
  assert.deepEqual(result.skipped, []);
});

test('a Data triggered by a pin sends over USB on that trigger, not on a clock', () => {
  const board = build(({ add, wire, f }) => {
    const data = add(f.data('hellooo'));
    wire('DI1', [data, 'in']);
    wire([data, 'out'], 'USB');
  });
  const design = circuit.buildInternalDevkitDesign(board);
  assert.deepEqual(design.blocks.map((b) => b.type).sort(), ['belt', 'belt', 'data', 'din', 'serial']);
  assert.equal(design.blocks.find((b) => b.type === 'din').data.gpio, 4);
  const { result } = roundTrip(board);
  assert.deepEqual(result.created.map((b) => kindOf(b)), ['data']);
  assert.equal(result.connections.length, 2);
});

test('a Data nothing feeds is resent on a marked clock, which a load folds away; a drawn Timer is kept', () => {
  const constant = build(({ add, wire, f }) => wire([add(f.data('tick')), 'out'], 'USB'));
  const design = circuit.buildInternalDevkitDesign(constant);
  assert.equal(design.blocks.find((b) => b.type === 'timer').data.role, 'usb-resend');
  const { result } = roundTrip(constant);
  assert.deepEqual(result.created.map((b) => kindOf(b)), ['data']);

  const timed = build(({ add, wire, f }) => {
    const data = add(f.data('tock'));
    wire([add(f.timer(500, 500)), 'out'], [data, 'in']);
    wire([data, 'out'], 'USB');
  });
  const drawn = roundTrip(timed);
  assert.deepEqual(drawn.result.created.map((b) => kindOf(b)).sort(), ['data', 'timer']);
});

test('Timer and AND circuits survive the round trip', () => {
  const timed = roundTrip(build(({ add, wire, f }) => wire([add(f.timer(200, 800)), 'out'], 'DO1')));
  const timer = timed.result.created.find((b) => kindOf(b) === 'timer');
  assert.equal(timer.children.blocks.get('on').props[0].value, 200);
  const gated = roundTrip(build(({ add, wire, f }) => {
    const and = add(f.and());
    wire('DI1', [and, 'a']);
    wire('DI2', [and, 'b']);
    wire([and, 'out'], 'DO3');
  }));
  assert.deepEqual(gated.result.created.map((b) => kindOf(b)), ['and']);
});

test('a load replaces what was inside and grows the frame to fit', () => {
  const design = circuit.buildInternalDevkitDesign(build(({ add, wire, f }) => wire([add(f.data('1')), 'out'], 'DO1')));
  const board = build(({ add }) => add(stubFactories().and()));
  const before = board.boundaryGeometry.width;
  importDesign({ design, esp: board, pinMap, factories: stubFactories(), replace: true });
  assert.equal([...board.children.blocks.values()].every((b) => kindOf(b) !== 'and'), true);
  assert.ok(board.boundaryGeometry.width >= before);
});

test('the same circuit laid out differently, or padded with idle declarations, is the same design', () => {
  const compiled = circuit.buildInternalDevkitDesign(build(({ add, wire, f }) => {
    wire([add(f.timer(500, 500)), 'out'], 'DO1');
    wire('DI1', 'DO2');
  }));
  // Every row moved down and right, plus what an older compiler used to
  // declare on its own: unwired inputs and an idle CAN block.
  const moved = { blocks: [
    ...compiled.blocks.map((b) => ({ ...b, gx: b.gx + 5, gy: b.gy + 7 })),
    { id: 90, type: 'din', gx: 0, gy: 30, data: { gpio: 5, emitOnChange: true } },
    { id: 91, type: 'din', gx: 3, gy: 30, data: { gpio: 6, emitOnChange: true } },
    { id: 92, type: 'can', gx: 12, gy: 30, data: { tx: 2, rx: 3, bitrate: 250000, format: 'string' } },
  ] };
  assert.equal(circuit.designsMatch(compiled, moved), true);
  const rewired = { blocks: compiled.blocks.map((b) => (b.type === 'dout' && b.data.exio === 1 ? { ...b, data: { exio: 3 } } : b)) };
  assert.equal(circuit.designsMatch(compiled, rewired), false, 'a different pin is a different circuit');
  const twoData = circuit.buildInternalDevkitDesign(build(({ add, wire, f }) => {
    wire([add(f.data('go')), 'out'], 'DO1');
    wire([add(f.data('go')), 'out'], 'DO2');
  }));
  const oneData = circuit.buildInternalDevkitDesign(build(({ add, wire, f }) => wire([add(f.data('go')), 'out'], 'DO1')));
  assert.equal(circuit.designsMatch(twoData, oneData), false, 'two identical Data blocks are not one');
});

test('dirty means the compiled design is not what the device was last confirmed to hold', () => {
  const board = build(({ wire }) => wire('DI1', 'DO1'));
  assert.equal(circuit.isDevkitDirty(board, { blocks: new Map(), connections: new Map() }), true, 'never confirmed');
  const sent = circuit.buildInternalDevkitDesign(board);
  circuit.markDevkitSent(board, { blocks: sent.blocks.map((b) => ({ ...b, id: b.id + 100 })), nextId: 999 });
  assert.equal(circuit.isDevkitDirty(board, { blocks: new Map(), connections: new Map() }), false, 'ids and nextId are bookkeeping');
  const extra = stubFactories().connection({ sourceBlockId: board.id, sourcePortId: boardPort(board, 'DI2'), targetBlockId: board.id, targetPortId: boardPort(board, 'DO2') });
  board.children.connections.set(extra.id, extra);
  assert.equal(circuit.isDevkitDirty(board, { blocks: new Map(), connections: new Map() }), true);
  assert.equal(circuit.isDevkitDirty(freshBoard(), { blocks: new Map(), connections: new Map() }), false, 'nothing to send is not unsaved');
});

test('the CNC settings are circuit: a changed pin setting is a different design, key order is not', () => {
  // What buildPinMappedDesign sends for a placed CNC with nothing wired to
  // its in or out: one `cnc` block carrying grbl's settings, reached by no
  // belt. A wire from X step to IO1 changes only x/step/pin.
  const cncDesign = (settings) => ({ blocks: [{ id: 1, type: 'cnc', gx: 0, gy: 1, data: { settings } }], nextId: 2 });
  const unwired = cncDesign({ 'x/steps_per_mm': 100, 'x/step/pin': -1, 'x/dir/pin': -1 });
  const wired = cncDesign({ 'x/steps_per_mm': 100, 'x/step/pin': 1, 'x/dir/pin': -1 });
  const reordered = cncDesign({ 'x/dir/pin': -1, 'x/step/pin': 1, 'x/steps_per_mm': 100 });
  assert.notEqual(circuit.canonicalDesign(unwired), circuit.canonicalDesign({ blocks: [] }), 'placing the CNC is a change');
  assert.notEqual(circuit.canonicalDesign(wired), circuit.canonicalDesign(unwired), 'X step on IO1 is a change');
  assert.ok(circuit.designsMatch(wired, reordered), 'the same settings read back in another order still match');
});

test('a CAN wire to another board is not a circuit: the device\'s own is still loaded', () => {
  const board = freshBoard();
  const other = freshBoard();
  other.id = 'other-board';
  const level = {
    blocks: new Map([[board.id, board], [other.id, other]]),
    connections: new Map([['bus', { sourceBlockId: board.id, sourcePortId: boardPort(board, 'CAN'), targetBlockId: other.id, targetPortId: boardPort(other, 'CAN') }]]),
  };
  assert.equal(circuit.hasAnyCircuit(board, level), false, 'the bus between two boards');
  const data = { id: 'd1', props: [{ name: 'noditronKind', value: 'data' }], logicalPorts: [], ports: [] };
  level.blocks.set(data.id, data);
  level.connections.set('w', { sourceBlockId: data.id, sourcePortId: 'x', targetBlockId: board.id, targetPortId: boardPort(board, 'CAN') });
  assert.equal(circuit.hasAnyCircuit(board, level), true, 'a block beside it wired to its pin is');
});

test('loading a device circuit nothing here can show leaves the drawing as it was', () => {
  const board = freshBoard();
  board.children.blocks.set('kept', { id: 'kept', name: 'Kept', props: [], logicalPorts: [], ports: [] });
  const result = importDesign({ design: { blocks: [{ id: 1, type: 'i2cout', gx: 0, gy: 0, data: {} }] }, esp: board, pinMap, factories: stubFactories(), replace: true });
  assert.equal(result.restored, true);
  assert.ok(board.children.blocks.has('kept'), 'the block that was there is still there');
});

test('a jog button box: the Gate (Route) and a Delay compile and come back as drawn', () => {
  // Per button: press/release -> Match 1/0 -> start / stop -> CAN; the
  // CNC's echo -> Match -> Delay -> Gate (sel = the button) -> out2 ->
  // `x jog continue` -> CAN. Held, every echo is answered 100 ms later;
  // released, the Gate sends it to the unwired out1.
  const board = build(({ add, wire, f }) => {
    for (const [pin, dir] of [['DI1', 'minus'], ['DI2', 'plus']]) {
      const press = add(f.match(['1', '0'], 2));
      const start = add(f.data(`x jog start ${dir}`));
      const stop = add(f.data('x jog stop'));
      wire(pin, [press, 'in']);
      wire([press, 'out1'], [start, 'in']);
      wire([press, 'out2'], [stop, 'in']);
      wire([start, 'out'], 'CAN');
      wire([stop, 'out'], 'CAN');
      const echo = add(f.match([`x jogging ${dir}`], 1));
      const wait = add(f.delay(100));
      const gate = add(f.route());
      const cont = add(f.data('x jog continue'));
      wire('CAN', [echo, 'in']);
      wire([echo, 'out1'], [wait, 'in']);
      wire(pin, [gate, 'sel']);
      wire([wait, 'out'], [gate, 'in']);
      wire([gate, 'out2'], [cont, 'in']);
      wire([cont, 'out'], 'CAN');
    }
  });
  const notes = [];
  const design = circuit.buildInternalDevkitDesign(board, null, { notes });
  assert.deepEqual(notes, [], 'nothing left out');
  assert.equal(design.blocks.filter((b) => b.type === 'route').length, 2);
  assert.equal(design.blocks.filter((b) => b.type === 'timer' && b.data.mode === 'delay' && b.data.onTime === 100).length, 2);
  const edges = traceDesign(design).edges.map((e) => `${e.from.type}${e.output ?? ''}>${e.to.type}${e.input ?? ''}`);
  assert.ok(edges.includes('timer>route2'), 'the delay feeds the gate\'s channel');
  assert.ok(edges.includes('din>route0'), 'the button is the gate\'s sel');
  assert.ok(edges.includes('route1>data'), 'out2 (firmware output 1) feeds continue');
  roundTrip(board);
});
