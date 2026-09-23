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
  assert.equal(module.displayName, 'esp32-S3');
  assert.equal(board.name, 'esp32-S3');
  assert.deepEqual(pins.filter(p => p.inputOnly).map(p => p.gpio), [4,5,6,7,8,9,10,11]);
  assert.deepEqual(pins.filter(p => p.outputOnly).map(p => p.exio), [1,2,3,4,5,6,7,8]);
  assert.equal(board.logicalPorts.find(p => p.name === 'DI1').direction, 'in');
  assert.equal(board.logicalPorts.find(p => p.name === 'DO1').direction, 'out');
  assert.equal(pins.find(p => p.label === 'CAN TX').gpio, 2);
  assert.equal(pins.find(p => p.label === 'CAN RX').gpio, 3);
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

test('fixed hardware directions and bus pins cannot become arbitrary GPIOs', () => {
  assert.throws(() => circuit.buildInternalDevkitDesign(wired('DO1', 'DI1')), /digital input/);
  assert.throws(() => circuit.buildInternalDevkitDesign(wired('DI1', 'DI2')), /digital output/);
  assert.throws(() => circuit.buildInternalDevkitDesign(wired('CAN RX', 'DO1')), /digital input/);
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
  assert.match(flashSource, /build: '20260924b'/);
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
