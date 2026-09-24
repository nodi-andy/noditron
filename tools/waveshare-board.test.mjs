import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const module = JSON.parse(read('../modules/esp32-s3-devkit/noditron.module.json'));
const board = module.block.blocks[0];
const pins = JSON.parse(board.props.find(p => p.name === 'pinMap').value);
const strip = s => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const serial = new Function(strip(read('../client/src/serialConsole.js')) + '\nreturn { buildMinimalDesign };')();
const circuit = new Function('serialConsole', 'kindOf', strip(read('../client/src/devkitCircuit.js')) + '\nreturn { buildInternalDevkitDesign, migrateWaveshareBoard };')(
  serial, b => b.props.find(p => p.name === 'noditronKind')?.value,
);
function wired(from, to) {
  const port = label => board.ports.find(p => board.logicalPorts.find(lp => lp.id === p.logicalId)?.name === label).id;
  return { ...board, children: { blocks: new Map(), connections: new Map([['wire', {
    sourceBlockId: board.id, sourcePortId: port(from), targetBlockId: board.id, targetPortId: port(to),
  }]]) } };
}

test('Waveshare name, eight isolated inputs, eight driver outputs and CAN pins', () => {
  assert.equal(module.version, '1.7.1');
  assert.equal(module.displayName, 'esp32-S3');
  assert.equal(board.name, 'esp32-S3');
  assert.deepEqual(pins.filter(p => p.role === 'digital-input').map(p => p.gpio), [4,5,6,7,8,9,10,11]);
  assert.deepEqual(pins.filter(p => p.role === 'digital-output').map(p => p.exio), [1,2,3,4,5,6,7,8]);
  assert.equal(board.logicalPorts.find(p => p.name === 'DI1').direction, 'in');
  assert.equal(board.logicalPorts.find(p => p.name === 'DO1').direction, 'out');
  assert.equal(pins.find(p => p.label === 'CAN Out').gpio, 2);
  assert.equal(pins.find(p => p.label === 'CAN In').gpio, 3);
  assert.equal(board.logicalPorts.find(p => p.name === 'CAN speed').direction, 'out');
});

test('the device dialog accepts circuits wired directly to board terminals', () => {
  const source = board.props.find(p => p.name === 'dialog').value;
  assert.match(source, /programLabel\.textContent = 'CIRCUIT'/);
  assert.match(source, /compiledCount = compiled\.blocks\.length/);
  assert.doesNotMatch(source, /No Digital I\/O blocks|add a Digital I\/O block/);
  assert.match(source, /connect a supported circuit signal directly to DI, DO, CAN In, or CAN Out/);
});

test('an already placed Waveshare block receives corrected DI and DO directions', () => {
  const old = structuredClone(board);
  old.logicalPorts.find(p => p.name === 'DI1').direction = 'out';
  old.logicalPorts.find(p => p.name === 'DO1').direction = 'in';
  assert.equal(circuit.migrateWaveshareBoard(old, board, { connections: new Map() }), true);
  assert.equal(old.logicalPorts.find(p => p.name === 'DI1').direction, 'in');
  assert.equal(old.logicalPorts.find(p => p.name === 'DO1').direction, 'out');
});

test('each DI to DO connection exports a real input and an EXIO output', () => {
  for (let channel = 1; channel <= 8; channel++) {
    const design = circuit.buildInternalDevkitDesign(wired(`DI${channel}`, `DO${channel}`));
    assert.deepEqual(design.blocks.find(b => b.type === 'din').data, { gpio: channel + 3, emitOnChange: true });
    assert.deepEqual(design.blocks.find(b => b.type === 'dout').data, { exio: channel });
    assert.equal(design.blocks.filter(b => b.type === 'belt').length, 1);
  }
});

test('a pinless Bool between DI1 and DO1 is compiled as a pass-through', () => {
  const esp = structuredClone(board);
  const bool = {
    id: 'bool',
    logicalPorts: [
      { id: 'bool-in', name: 'in', direction: 'in' },
      { id: 'bool-out', name: 'out', direction: 'out' },
    ],
    ports: [
      { id: 'bool-in-port', logicalId: 'bool-in' },
      { id: 'bool-out-port', logicalId: 'bool-out' },
    ],
    props: [
      { name: 'noditronKind', value: 'digital-io' },
      { name: 'pin', value: '' },
      { name: 'direction', value: 'input' },
    ],
  };
  const port = label => esp.ports.find(p => esp.logicalPorts.find(lp => lp.id === p.logicalId)?.name === label).id;
  esp.children = {
    blocks: new Map([[bool.id, bool]]),
    connections: new Map([
      ['into-bool', { sourceBlockId: esp.id, sourcePortId: port('DI1'), targetBlockId: bool.id, targetPortId: 'bool-in-port' }],
      ['out-of-bool', { sourceBlockId: bool.id, sourcePortId: 'bool-out-port', targetBlockId: esp.id, targetPortId: port('DO1') }],
    ]),
  };
  const design = circuit.buildInternalDevkitDesign(esp);
  assert.deepEqual(design.blocks.map(({ type, data }) => ({ type, data })), [
    { type: 'din', data: { gpio: 4, emitOnChange: true } },
    { type: 'dout', data: { exio: 1 } },
    { type: 'belt', data: { dir: 'E' } },
  ]);
});

test('fixed hardware directions and bus pins cannot become arbitrary GPIOs', () => {
  assert.throws(() => circuit.buildInternalDevkitDesign(wired('DO1', 'DI1')), /digital input/);
  assert.throws(() => circuit.buildInternalDevkitDesign(wired('DI1', 'DI2')), /digital output/);
  assert.throws(() => circuit.buildInternalDevkitDesign(wired('CAN Out', 'DI1')), /only accepts data/);
});

test('CAN Out sends connected Data at the configured speed without a visible CAN block', () => {
  const esp = structuredClone(board);
  const data = (id, value) => ({
    id, logicalPorts: [{ id: `${id}-out`, name: 'out', direction: 'out' }],
    ports: [{ id: `${id}-port`, logicalId: `${id}-out` }],
    props: [{ name: 'noditronKind', value: 'data' }, { name: 'value', value }],
  });
  const payload = data('payload', '123#AA');
  const speed = data('speed', '500k');
  const port = label => esp.ports.find(p => esp.logicalPorts.find(lp => lp.id === p.logicalId)?.name === label).id;
  esp.children = {
    blocks: new Map([[payload.id, payload], [speed.id, speed]]),
    connections: new Map([
      ['payload', { sourceBlockId: payload.id, sourcePortId: 'payload-port', targetBlockId: esp.id, targetPortId: port('CAN Out') }],
      ['speed', { sourceBlockId: speed.id, sourcePortId: 'speed-port', targetBlockId: esp.id, targetPortId: port('CAN speed') }],
    ]),
  };
  const design = circuit.buildInternalDevkitDesign(esp);
  assert.deepEqual(design.blocks.find(b => b.type === 'can').data, { tx: 2, rx: 3, bitrate: 500000, format: 'string' });
  assert.ok(design.blocks.some(b => b.type === 'boot'));
  assert.equal(design.blocks.find(b => b.type === 'data').data.value, '123#AA');
});

test('CAN In is a direct source and defaults to 250 kbit/s', () => {
  const design = circuit.buildInternalDevkitDesign(wired('CAN In', 'DO1'));
  assert.deepEqual(design.blocks.find(b => b.type === 'can').data, { tx: 2, rx: 3, bitrate: 250000, format: 'string' });
  assert.deepEqual(design.blocks.find(b => b.type === 'dout').data, { exio: 1 });
});

test('Waveshare preset is selected after S3 detection', () => {
  const source = board.props.find(p => p.name === 'dialog').value;
  const start = source.indexOf('      const family = detected.chipName');
  const finish = '      installBtn.disabled = !matchingPreset;';
  const end = source.indexOf(finish, start) + finish.length;
  const presets = [{ id: 'generic', chip: 'ESP32-S3' }, { id: 'logic-esp32-s3-waveshare', chip: 'ESP32-S3' }];
  const select = { options: presets.map(p => ({ value: p.id })) };
  new Function('detected', 'presets', 'firmwareSelect', 'installBtn', 'props', source.slice(start, end))(
    { chipName: 'ESP32-S3 (QFN56)' }, presets, select, {}, { firmwarePreset: 'logic-esp32-s3-waveshare' },
  );
  assert.equal(select.value, 'logic-esp32-s3-waveshare');
});

test('an older running build exposes the firmware update action', () => {
  const source = board.props.find(p => p.name === 'dialog').value;
  assert.match(source, /FIRMWARE UPDATE AVAILABLE/);
  assert.match(source, /info\.build < preferredPreset\.build/);
  assert.match(source, /showRunning\(info\)/);
  const flashSource = read('../client/src/serialFlash.js');
  assert.match(flashSource, /build: '20260924e'/);
});

test('existing DevKit input wires retain their IDs and obsolete wired pins survive', () => {
  const old = {
    id: 'old', name: 'ESP32-S3 DevKit',
    props: [{ name: 'boardVariant', value: 'ESP32-S3-DevKitC-1' }],
    logicalPorts: [{ id: 'input', name: 'G4' }, { id: 'legacy', name: 'G35' }, { id: 'unused', name: 'G48' }],
    ports: [{ id: 'a', logicalId: 'input' }, { id: 'b', logicalId: 'legacy' }, { id: 'c', logicalId: 'unused' }],
  };
  const level = { connections: new Map([['wire', { sourceBlockId: 'old', sourcePortId: 'b' }]]) };
  assert.equal(circuit.migrateWaveshareBoard(old, board, level), true);
  assert.equal(old.name, 'esp32-S3');
  assert.deepEqual(old.logicalPorts.map(p => p.name), ['DI1', 'G35']);
  assert.deepEqual(old.ports.map(p => p.id), ['a', 'b']);
  assert.match(old.logicalPorts[1].description, /Legacy/);
});

test('a placed Waveshare board keeps its own slot positions across reloads', () => {
  const placed = structuredClone(board);
  const di1 = placed.logicalPorts.find(p => p.name === 'DI1');
  const port = placed.ports.find(p => p.logicalId === di1.id);
  Object.assign(port, { side: 'top', offset: 123 });
  circuit.migrateWaveshareBoard(placed, board, { connections: new Map() });
  assert.deepEqual({ side: port.side, offset: port.offset }, { side: 'top', offset: 123 });
});

test('DI1 into a Data block\'s write drives DO2 from its out', () => {
  const esp = structuredClone(board);
  const data = {
    id: 'data',
    logicalPorts: ['write', 'in', 'out'].map(name => ({ id: `data-${name}`, name, direction: name === 'out' ? 'out' : 'in' })),
    ports: ['write', 'in', 'out'].map(name => ({ id: `data-${name}-port`, logicalId: `data-${name}` })),
    props: [{ name: 'noditronKind', value: 'data' }, { name: 'value', value: '0' }],
  };
  const port = label => esp.ports.find(p => esp.logicalPorts.find(lp => lp.id === p.logicalId)?.name === label).id;
  esp.children = {
    blocks: new Map([[data.id, data]]),
    connections: new Map([
      ['di1', { sourceBlockId: esp.id, sourcePortId: port('DI1'), targetBlockId: data.id, targetPortId: 'data-write-port' }],
      ['do2', { sourceBlockId: data.id, sourcePortId: 'data-out-port', targetBlockId: esp.id, targetPortId: port('DO2') }],
    ]),
  };
  const design = circuit.buildInternalDevkitDesign(esp);
  assert.deepEqual(design.blocks.map(({ type, data }) => ({ type, data })), [
    { type: 'din', data: { gpio: 4, emitOnChange: true } },
    { type: 'dout', data: { exio: 2 } },
    { type: 'belt', data: { dir: 'E' } },
  ]);
});

// DI → Match → Data → CAN Out: conucon's own GUI layout for driving the grbl
// controller over CAN — each input's croute rows end in Data blocks that all
// run into one tall CAN block.
function matchToCan({ writeToo = false } = {}) {
  const esp = structuredClone(board);
  const port = label => esp.ports.find(p => esp.logicalPorts.find(lp => lp.id === p.logicalId)?.name === label).id;
  const block = (id, kind, ports, props = []) => ({
    id,
    logicalPorts: ports.map(([name, direction]) => ({ id: `${id}-${name}`, name, direction })),
    ports: ports.map(([name]) => ({ id: `${id}-${name}-port`, logicalId: `${id}-${name}` })),
    props: [{ name: 'noditronKind', value: kind }, ...props],
  });
  const match = block('match', 'croute', [['in', 'in'], ['1', 'out'], ['0', 'out']], [{ name: 'routes', value: '["1", "0"]' }]);
  const data = (id, value) => block(id, 'data', [['in', 'in'], ['write', 'in'], ['out', 'out']], [{ name: 'value', value }]);
  const on = data('on', 'X100');
  const off = data('off', 'X0');
  const wire = (id, s, sp, t, tp) => [id, { sourceBlockId: s, sourcePortId: sp, targetBlockId: t, targetPortId: tp }];
  esp.children = {
    blocks: new Map([match, on, off].map(b => [b.id, b])),
    connections: new Map([
      wire('di', esp.id, port('DI1'), 'match', 'match-in-port'),
      wire('m1', 'match', 'match-1-port', 'on', 'on-in-port'),
      wire('m0', 'match', 'match-0-port', 'off', 'off-in-port'),
      wire('c1', 'on', 'on-out-port', esp.id, port('CAN Out')),
      wire('c0', 'off', 'off-out-port', esp.id, port('CAN Out')),
      ...(writeToo ? [wire('w1', 'match', 'match-1-port', 'on', 'on-write-port')] : []),
    ]),
  };
  return circuit.buildInternalDevkitDesign(esp);
}

test('DI → Match → Data → CAN Out compiles to din → croute → data rows → one tall can block', () => {
  const design = matchToCan();
  const at = (type, gx, gy) => design.blocks.find(b => b.type === type && b.gx === gx && b.gy === gy);
  assert.deepEqual(at('din', 0, 0).data, { gpio: 4, emitOnChange: true });
  assert.deepEqual(at('croute', 3, 0).data, { routes: ['1', '0'] });
  assert.equal(at('data', 6, 0).data.value, 'X100');
  assert.equal(at('data', 6, 1).data.value, 'X0');
  assert.deepEqual({ ...at('can', 9, 0), id: 0 }, { id: 0, type: 'can', gx: 9, gy: 0, w: 2, h: 2, data: { tx: 2, rx: 3, bitrate: 250000, format: 'string' } });
  for (const [gx, gy] of [[2, 0], [5, 0], [8, 0], [5, 1], [8, 1]]) assert.ok(at('belt', gx, gy), `belt at ${gx},${gy}`);
  assert.equal(design.blocks.filter(b => b.type === 'boot').length, 0, 'nothing is sent unprompted at boot');
});

test('a Data also written from its Match forwards the signal, so its row cannot sit beside a Data row', () => {
  const design = matchToCan({ writeToo: true });
  const rows = design.blocks.filter(b => b.type === 'data').map(b => b.data.value);
  assert.deepEqual(rows, ['X0'], 'the written Data is a pass-through, dropped next to the triggered one');
});
