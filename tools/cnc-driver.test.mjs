import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The CNC block inside the 2IO board: grbl built into the Logic Module
// firmware (conucon's logic-cnc-esp32s3-2io). Its line ports compile to the
// firmware's `cnc` block, its pin ports to grbl's pin settings, its
// subgraph to the rest of the settings — see devkitCircuit's CNC section.
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const boardOf = (name) => JSON.parse(read(`../modules/${name}/noditron.module.json`)).block.blocks[0];
const board = boardOf('esp32s3-2io-logic');
const strip = s => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const kindOf = b => b.props.find(p => p.name === 'noditronKind')?.value;
const serial = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { buildMinimalDesign };')();
const circuit = new Function('serialConsole', 'kindOf', strip(read('../client/src/devkitCircuit.js')) + '\nreturn { buildInternalDevkitDesign };')(serial, kindOf);
const restrictions = new Function(strip(read('../client/src/containerRestrictions.js')) + '\nreturn { kindOffered };')();

const port = (block, label) => block.ports.find(p => block.logicalPorts.find(lp => lp.id === p.logicalId)?.name === label).id;
const value = (name, v) => ({ id: `v-${name}`, name, logicalPorts: [], ports: [], props: [{ name: 'noditronKind', value: 'data' }, { name: 'value', value: v }] });
// An on/off setting is a Bool (palette.js's createBoolBlock, no ports).
const bool = (name, on) => ({ id: `b-${name}`, name, logicalPorts: [], ports: [], props: [{ name: 'noditronKind', value: 'digital-io' }, { name: 'pin', value: null }, { name: 'value', value: on ? 1 : 0 }] });
const data = (id, v) => ({
  id, logicalPorts: [{ id: `${id}-out`, name: 'out', direction: 'out' }],
  ports: [{ id: `${id}-port`, logicalId: `${id}-out` }],
  props: [{ name: 'noditronKind', value: 'data' }, { name: 'value', value: v }],
});
// What palette.js's createCncBlock makes, as plain data.
function cncBlock() {
  const names = [['in', 'in'], ['X limit', 'in'], ['Y limit', 'in'], ['out', 'out'], ['X step', 'out'], ['X dir', 'out'], ['Y step', 'out'], ['Y dir', 'out'], ['enable', 'out']];
  const group = (name, values) => ({ id: `g-${name}`, name, logicalPorts: [], ports: [], props: [],
    children: { blocks: new Map(values.map(v => [v.id, v])), connections: new Map() } });
  const groups = [group('X', [value('steps_per_mm', 80), value('maxrate', 5000)]), group('Homing', [bool('enable', true), bool('squared', false)])];
  return {
    id: 'cnc', name: 'CNC',
    logicalPorts: names.map(([name, direction]) => ({ id: `cnc-lp-${name}`, name, direction })),
    ports: names.map(([name]) => ({ id: `cnc-p-${name}`, logicalId: `cnc-lp-${name}` })),
    props: [{ name: 'noditronKind', value: 'cnc' }],
    children: { blocks: new Map(groups.map(g => [g.id, g])), connections: new Map() },
  };
}
function inside(esp, blocks, wires) {
  esp.children = { blocks: new Map(blocks.map(b => [b.id, b])), connections: new Map(wires.map((w, i) => [`w${i}`, w])) };
  return esp;
}
const wire = (sourceBlockId, sourcePortId, targetBlockId, targetPortId) => ({ sourceBlockId, sourcePortId, targetBlockId, targetPortId });

test('the CNC block is offered only inside a board whose firmware has the driver', () => {
  const allowed = b => JSON.parse(b.props.find(p => p.name === 'allowedChildKinds').value);
  assert.ok(allowed(board).includes('cnc'));
  assert.ok(!allowed(boardOf('esp32s3-8io-logic')).includes('cnc'));
  assert.equal(restrictions.kindOffered(null, 'cnc'), false, 'not on an unrestricted level');
  assert.equal(restrictions.kindOffered(null, 'data'), true);
  assert.equal(restrictions.kindOffered(allowed(board), 'cnc'), true);
  assert.ok(!board.logicalPorts.some(p => p.name === 'CNC'), 'no CNC pin on the board itself: the block is the driver');
});

test('pin wires are grbl\'s pin settings, the subgraph the rest, and Data → in a line for grbl', () => {
  const esp = structuredClone(board);
  const cnc = cncBlock();
  const line = data('line', '$J=G91 X10 F500');
  inside(esp, [cnc, line], [
    wire('line', 'line-port', 'cnc', port(cnc, 'in')),
    wire('cnc', port(cnc, 'X step'), esp.id, port(esp, 'IO4')),
    wire('cnc', port(cnc, 'X dir'), esp.id, port(esp, 'IO5')),
    wire(esp.id, port(esp, 'IO6'), 'cnc', port(cnc, 'X limit')),
  ]);
  const design = circuit.buildInternalDevkitDesign(esp);
  const cncs = design.blocks.filter(b => b.type === 'cnc');
  assert.equal(cncs.length, 1);
  assert.deepEqual(cncs[0].data.settings, {
    'x/steps_per_mm': 80, 'x/maxrate': 5000, 'homing/enable': 1, 'homing/squared': 0,
    'x/step/pin': 4, 'x/dir/pin': 5, 'x/limit/pin': 6,
    'y/step/pin': -1, 'y/dir/pin': -1, 'y/limit/pin': -1, 'stepper/disable/pin': -1,
    'x/disable/pin': -1, 'y/disable/pin': -1,
  });
  assert.equal(design.blocks.find(b => b.type === 'data').data.value, '$J=G91 X10 F500');
  assert.ok(!design.blocks.some(b => b.type === 'dout' || b.type === 'din'), 'a CNC pin wire compiles to nothing at run time');
});

test('a CNC with nothing wired still carries its settings, every pin off', () => {
  const design = circuit.buildInternalDevkitDesign(inside(structuredClone(board), [cncBlock()], []));
  const cnc = design.blocks.find(b => b.type === 'cnc');
  assert.equal(cnc.data.settings['x/step/pin'], -1);
  assert.equal(cnc.data.settings['x/steps_per_mm'], 80);
});

test('out carries what grbl prints into the circuit', () => {
  const esp = structuredClone(board);
  const cnc = cncBlock();
  inside(esp, [cnc], [wire('cnc', port(cnc, 'out'), esp.id, port(esp, 'IO10'))]);
  const design = circuit.buildInternalDevkitDesign(esp);
  assert.equal(design.blocks.filter(b => b.type === 'cnc').length, 1);
  assert.ok(design.blocks.some(b => b.type === 'dout'));
});

test('a board pin is the CNC\'s or the circuit\'s, not both; CNC pins go to board pins', () => {
  const esp = structuredClone(board);
  const cnc = cncBlock();
  const blink = data('blink', 1);
  inside(esp, [cnc, blink], [
    wire('cnc', port(cnc, 'X step'), esp.id, port(esp, 'IO4')),
    wire('blink', 'blink-port', esp.id, port(esp, 'IO4')),
  ]);
  assert.throws(() => circuit.buildInternalDevkitDesign(esp), /IO4 is the CNC's X step/);

  const esp2 = structuredClone(board);
  const cnc2 = cncBlock();
  const sink = data('sink', 0);
  inside(esp2, [cnc2, sink], [wire('cnc', port(cnc2, 'X step'), 'sink', 'sink-port')]);
  assert.throws(() => circuit.buildInternalDevkitDesign(esp2), /goes to one of the board's pins/);

  const esp3 = structuredClone(board);
  const cnc3 = cncBlock();
  inside(esp3, [cnc3], [
    wire('cnc', port(cnc3, 'X step'), esp3.id, port(esp3, 'IO4')),
    wire('cnc', port(cnc3, 'Y step'), esp3.id, port(esp3, 'IO4')),
  ]);
  assert.throws(() => circuit.buildInternalDevkitDesign(esp3), /cannot be both/);
});

// Homing: its `home` input wired to the axes in the order they home.
function homingBlock(wires) {
  const axis = (a) => ({
    id: `ax-${a}`, name: a.toUpperCase(),
    logicalPorts: [{ id: `ax-${a}-lh`, name: 'home', direction: 'in' }, { id: `ax-${a}-ld`, name: 'done', direction: 'out' }],
    ports: [{ id: `ax-${a}-h`, logicalId: `ax-${a}-lh` }, { id: `ax-${a}-d`, logicalId: `ax-${a}-ld` }],
    props: [{ name: 'noditronKind', value: 'cnc-home-axis' }, { name: 'axis', value: a }],
  });
  const axes = ['x', 'y', 'z'].map(axis);
  const end = (name) => name === 'home' ? ['homing', 'homing-home'] : [`ax-${name[0]}`, `ax-${name[0]}-${name.endsWith('done') ? 'd' : 'h'}`];
  return {
    id: 'homing', name: 'Homing',
    logicalPorts: [{ id: 'homing-lhome', name: 'home', direction: 'in' }],
    ports: [{ id: 'homing-home', logicalId: 'homing-lhome' }],
    props: [],
    children: {
      blocks: new Map([bool('enable', true), ...axes].map(b => [b.id, b])),
      // 'home>x' is Homing's home into X's; 'x.done>y' X's done into Y's home
      connections: new Map(wires.map((w, i) => {
        const [from, to] = w.split('>');
        const [sb, sp] = end(from);
        const [tb, tp] = end(to);
        return [`hw${i}`, { sourceBlockId: sb, sourcePortId: sp, targetBlockId: tb, targetPortId: tp }];
      })),
    },
  };
}
function cyclesOf(wires) {
  const cnc = cncBlock();
  const homing = homingBlock(wires);
  cnc.children.blocks.set(homing.id, homing);
  const s = circuit.buildInternalDevkitDesign(inside(structuredClone(board), [cnc], [])).blocks.find(b => b.type === 'cnc').data.settings;
  return [0, 1, 2, 3, 4, 5].map(i => s[`homing/cycle${i}`]);
}

test('Homing\'s wiring is grbl\'s homing order: together, after, joined, or not at all', () => {
  assert.deepEqual(cyclesOf(['home>x']), ['X', 0, 0, 0, 0, 0], 'as placed: X alone');
  assert.deepEqual(cyclesOf(['home>x', 'home>y']), ['XY', 0, 0, 0, 0, 0], 'from the same place: together');
  assert.deepEqual(cyclesOf(['home>z', 'z.done>x', 'z.done>y']), ['Z', 'XY', 0, 0, 0, 0], 'Z first, then X and Y');
  assert.deepEqual(cyclesOf(['home>x', 'x.done>y', 'y.done>z']), ['X', 'Y', 'Z', 0, 0, 0], 'a chain');
  assert.deepEqual(cyclesOf(['home>x', 'home>y', 'x.done>z', 'y.done>z']), ['XY', 'Z', 0, 0, 0, 0], 'Z after both');
  assert.deepEqual(cyclesOf([]), [0, 0, 0, 0, 0, 0], 'nothing wired: nothing homes');
  assert.throws(() => cyclesOf(['x.done>y', 'y.done>x', 'home>z']), /go round in a circle/);
});

test('a signal into the CNC\'s home compiles to the board\'s cnchome block', () => {
  const esp = structuredClone(board);
  const cnc = cncBlock();
  cnc.logicalPorts.push({ id: 'cnc-lp-home', name: 'home', direction: 'in' });
  cnc.ports.push({ id: 'cnc-p-home', logicalId: 'cnc-lp-home' });
  inside(esp, [cnc], [wire(esp.id, port(esp, 'IO12'), 'cnc', 'cnc-p-home')]);
  const design = circuit.buildInternalDevkitDesign(esp);
  assert.ok(design.blocks.some(b => b.type === 'cnchome'));
  assert.ok(design.blocks.some(b => b.type === 'din' && b.data?.gpio === 12));
});
