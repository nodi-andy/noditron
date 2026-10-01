import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { traceDesign, importDesign } from '../client/src/designImport.js';

// A Data's `write` port on the board (firmware build 20260928a and later:
// a data block two or more rows tall takes a belt on a lower row as a
// write — stored and sent on — and on its top row as the trigger), and
// what the compiler says about the shapes it still has no row for.
// The bench circuit that started this: DI1 → Match → Data "unlock" →
// Data (a collector) → CAN, with the Match route also wired into both
// Data blocks' write ports.
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const kindOf = (b) => b.props.find((p) => p.name === 'noditronKind')?.value;
const serial = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { buildMinimalDesign };')();
const circuit = new Function(
  'serialConsole', 'kindOf', 'serializeBlockDescription', 'traceDesign',
  strip(read('../client/src/devkitCircuit.js')) + '\nreturn { buildDevkitDesign, canonicalDesign, designsMatch };',
)(serial, kindOf, () => '', traceDesign);
const manifest = JSON.parse(read('../modules/esp32s3-8io-logic/noditron.module.json'));
const template = manifest.block.blocks[0];
const pinMap = JSON.parse(template.props.find((p) => p.name === 'pinMap').value);

let n = 0;
function block(name, kind, props = {}, ports = []) {
  const b = { id: `${name}-${(n += 1)}`, name, logicalPorts: [], ports: [], children: null, geometry: { x: 0, y: 0, width: 160, height: 60 },
    props: [{ name: 'noditronKind', value: kind }, ...Object.entries(props).map(([pn, value]) => ({ name: pn, value }))] };
  for (const [pname, direction, hidden] of ports) {
    const id = `${b.id}:${pname}`;
    b.logicalPorts.push({ id, name: pname, direction, ...(hidden ? { hidden: true } : {}) });
    b.ports.push({ id: `${id}:pin`, logicalId: id, side: direction === 'in' ? 'left' : 'right', offset: 20 });
  }
  return b;
}
const port = (b, name) => b.ports.find((p) => p.logicalId === `${b.id}:${name}`).id;
const boardPort = (board, label) => board.ports.find((p) => board.logicalPorts.find((lp) => lp.id === p.logicalId)?.name === label).id;
const wire = (s, sp, t, tp) => ({ id: `${sp}->${tp}`, sourceBlockId: s.id, sourcePortId: sp, targetBlockId: t.id, targetPortId: tp });
const match = () => block('Match', 'croute', { routes: '["1","0"]' }, [['in', 'in'], ['1', 'out'], ['0', 'out']]);
const data = (value) => block('Data', 'data', { value }, [['in', 'in'], ['write', 'in', true], ['out', 'out']]);
const timer = () => { const t = block('Timer', 'timer', {}, [['out', 'out']]); t.children = { blocks: new Map(), connections: new Map() }; return t; };
function levelWith(board, blocks, wires) {
  board.children = { blocks: new Map(blocks.map((b) => [b.id, b])), connections: new Map(wires.map((w) => [w.id, w])) };
  return { blocks: new Map([[board.id, board]]), connections: new Map() };
}
const compile = (board, level) => { const notes = []; const design = circuit.buildDevkitDesign(board, level, { notes }); return { design, notes }; };
const shape = (design) => design.blocks.filter((b) => b.type !== 'belt').map((b) => `${b.type}@${b.gx},${b.gy}${b.h ? `h${b.h}` : ''}${b.data?.value !== undefined ? `=${b.data.value}` : ''}`);
const beltsAt = (design) => design.blocks.filter((b) => b.type === 'belt').map((b) => `${b.gx},${b.gy}${b.data.dir}`);

// The firmware's delivery rule, as traceDesign models it: the cell a belt
// points into, and which input of the block that is.
const landings = (design) => traceDesign(design).edges.map((e) => `${e.from.type}${e.from.data?.value !== undefined ? `(${e.from.data.value})` : ''}>${e.to.type}${e.to.data?.value !== undefined ? `(${e.to.data.value})` : ''}:${e.input ?? 'in'}`);

test('a collector at the end of a Match chain: the route triggers Data "unlock", whose out writes the collector, whose out goes to CAN', () => {
  const board = structuredClone(template);
  const m = match(); const unlock = data('unlock'); const collector = data(0);
  const level = levelWith(board, [m, unlock, collector], [
    wire(board, boardPort(board, 'DI1'), m, port(m, 'in')),
    wire(m, port(m, '1'), unlock, port(unlock, 'in')),
    wire(unlock, port(unlock, 'out'), collector, port(collector, 'write')),
    wire(collector, port(collector, 'out'), board, boardPort(board, 'CAN')),
  ]);
  const { design, notes } = compile(board, level);
  assert.deepEqual(notes, []);
  // The collector is three rows tall: a trigger row above the chain, and
  // one write row per chain row (the Match has two routes).
  assert.deepEqual(shape(design), ['din@0,1', 'croute@3,1h2', 'data@6,1h1=unlock', 'data@9,0h3=0', 'can@12,0'], shape(design).join(' | '));
  // The chain lands on the collector's second row (its write row); the
  // collector's own out leaves from its top row into CAN.
  assert.deepEqual(landings(design), ['din>croute:in', 'croute>data(unlock):in', 'data(unlock)>data(0):write', 'data(0)>can:in']);
});

test('the bench wiring: the same chain, plus two stray wires from the route into write ports — one is ignored with a word, "unlock" still goes out', () => {
  const board = structuredClone(template);
  const m = match(); const unlock = data('unlock'); const collector = data(0);
  const level = levelWith(board, [m, unlock, collector], [
    wire(board, boardPort(board, 'DI1'), m, port(m, 'in')),
    wire(m, port(m, '1'), unlock, port(unlock, 'in')),
    wire(m, port(m, '1'), unlock, port(unlock, 'write')),
    wire(unlock, port(unlock, 'out'), collector, port(collector, 'write')),
    wire(m, port(m, '1'), collector, port(collector, 'write')),
    wire(collector, port(collector, 'out'), board, boardPort(board, 'CAN')),
  ]);
  const { design, notes } = compile(board, level);
  assert.deepEqual(landings(design), ['din>croute:in', 'croute>data(unlock):in', 'data(unlock)>data(0):write', 'data(0)>can:in'], 'the Data row wins the route; the direct write of the collector is the same row');
  // Every block has a row; the two stray wires from the route are named.
  assert.equal(notes.length, 2, notes.join('\n'));
  assert.ok(notes.some((t) => /A second wire from Match\.1 into Data is not on the board/.test(t)), notes.join('\n'));
  assert.ok(notes.some((t) => /Match also writes Data; that wire is not on the board/.test(t)), notes.join('\n'));
});

test('writer rows: an Input pin writes a Data whose out drives an Output pin; a Timer triggers it', () => {
  const board = structuredClone(template);
  const store = data('idle');
  const t = timer();
  const level = levelWith(board, [store, t], [
    wire(board, boardPort(board, 'DI2'), store, port(store, 'write')),
    wire(t, port(t, 'out'), store, port(store, 'in')),
    wire(store, port(store, 'out'), board, boardPort(board, 'DO1')),
  ]);
  const { design, notes } = compile(board, level);
  assert.deepEqual(notes, []);
  // The Timer (two rows tall, firing every belt along its edges) sits on
  // rows 0-1, the writer two rows below it; the Data spans down to the
  // writer's row.
  assert.deepEqual(shape(design), ['timer@0,0', 'din@0,2', 'data@6,0h3=idle', 'dout@9,0']);
  assert.deepEqual(landings(design).sort(), ['data(idle)>dout:in', 'din>data(idle):write', 'timer>data(idle):in']);
});

test('a written Data is read back from the device with a wire into its write port, and compiles to the same design', () => {
  const board = structuredClone(template);
  const m = match(); const unlock = data('unlock'); const collector = data(0);
  const level = levelWith(board, [m, unlock, collector], [
    wire(board, boardPort(board, 'DI1'), m, port(m, 'in')),
    wire(m, port(m, '1'), unlock, port(unlock, 'in')),
    wire(unlock, port(unlock, 'out'), collector, port(collector, 'write')),
    wire(collector, port(collector, 'out'), board, boardPort(board, 'CAN')),
  ]);
  const { design } = compile(board, level);
  // Stand-ins for the palette's factories: only what the importer touches.
  let k = 0;
  const mk = (kind, props, ports) => block(kind, kind, props, ports);
  const factories = {
    data: (value) => mk('data', { value }, [['in', 'in'], ['write', 'in', true], ['out', 'out']]),
    match: (routes, outputs) => mk('croute', { routes: JSON.stringify(routes) }, [['in', 'in'], ...Array.from({ length: outputs }, (_, i) => [String(i === 0 ? 1 : 0), 'out'])]),
    and: () => mk('and', {}, [['a', 'in'], ['b', 'in'], ['out', 'out']]),
    timer: () => timer(),
    digitalIo: (gpio, direction) => mk('digital-io', { pin: gpio, direction }, [['value', direction === 'output' ? 'in' : 'out']]),
    connection: (c) => ({ id: `c${(k += 1)}`, ...c }),
  };
  const fresh = structuredClone(template);
  fresh.children = { blocks: new Map(), connections: new Map() };
  const result = importDesign({ design, esp: fresh, pinMap, factories, replace: true });
  const kinds = result.created.map((c) => kindOf(c)).sort();
  assert.deepEqual(kinds, ['croute', 'data', 'data']);
  const written = result.created.find((c) => kindOf(c) === 'data' && String(c.props.find((p) => p.name === 'value').value) === '0');
  const writePort = written.logicalPorts.find((lp) => lp.name === 'write');
  assert.equal(writePort.hidden, undefined, 'the write port is shown once a wire arrives at it');
  assert.ok(result.connections.some((c) => c.targetBlockId === written.id && c.targetPortId === port(written, 'write')), 'the chain writes the collector');
  const again = circuit.buildDevkitDesign(fresh, { blocks: new Map([[fresh.id, fresh]]), connections: new Map() });
  assert.equal(circuit.canonicalDesign(again), circuit.canonicalDesign(design), 'round trip');
});

test('a Data written by something the board cannot run is named, with its writer', () => {
  const board = structuredClone(template);
  const store = data('x');
  const stray = data('y'); // a Data nothing triggers writes the store: no source to fire the row
  const level = levelWith(board, [store, stray], [
    wire(stray, port(stray, 'out'), store, port(store, 'write')),
    wire(store, port(store, 'out'), board, boardPort(board, 'DO1')),
  ]);
  const { notes } = compile(board, level);
  assert.ok(notes.some((t) => /Data "x" is written by Data\.out in a shape the board has no layout for/.test(t)), notes.join('\n'));
});

test('the shape the board runs has nothing to say: route into Data in, Data out into CAN', () => {
  const board = structuredClone(template);
  const m = match(); const unlock = data('unlock');
  const level = levelWith(board, [m, unlock], [
    wire(board, boardPort(board, 'DI1'), m, port(m, 'in')),
    wire(m, port(m, '1'), unlock, port(unlock, 'in')),
    wire(unlock, port(unlock, 'out'), board, boardPort(board, 'CAN')),
  ]);
  const { design, notes } = compile(board, level);
  assert.deepEqual(notes, []);
  assert.deepEqual(design.blocks.map((b) => b.type), ['din', 'belt', 'croute', 'belt', 'data', 'belt', 'can']);
});
