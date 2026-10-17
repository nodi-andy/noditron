import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// A board placed from an older pin layout of its module takes the new
// slots once (devkitCircuit.relayoutBoard, called from main.js's board
// sync): pins by name, wires kept, pins the module dropped gone unless wired.
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const template = JSON.parse(read('../modules/esp32s3-2io-logic/noditron.module.json')).block.blocks[0];
const strip = s => s.replace(/^import .*;$/gm, '').replace(/export /g, '');
const { relayoutBoard } = new Function('serialConsole', 'kindOf', strip(read('../client/src/devkitCircuit.js')) + '\nreturn { relayoutBoard };')({}, () => null);

// Your board before: IO4 first on the left, USB centred on top, the CNC pin.
function oldBoard() {
  const pins = [['IO4', 'left', 30], ['IO10', 'right', 30], ['USB', 'top', 140], ['CNC', 'right', 310], ['socket', 'left', 270]];
  return {
    id: 'esp', geometry: { x: 0, y: 0, width: 300, height: 340 },
    logicalPorts: pins.map(([name]) => ({ id: `lp-${name}`, name })),
    ports: pins.map(([name, side, offset]) => ({ id: `p-${name}`, logicalId: `lp-${name}`, side, offset })),
    props: [],
    children: { blocks: new Map(), connections: new Map([['w', { sourceBlockId: 'esp', sourcePortId: 'p-IO4', targetBlockId: 'x', targetPortId: 'x-in' }]]) },
  };
}
const slot = (block, name) => {
  const lp = block.logicalPorts.find(l => l.name === name);
  const p = lp && block.ports.find(q => q.logicalId === lp.id);
  return p ? `${p.side}${p.offset}` : null;
};

test('the 2IO module has IO1 and IO2, USB as a pin under the right-hand ones, CAN at the bottom-left', () => {
  assert.equal(slot(template, 'IO1'), 'left30');
  assert.equal(slot(template, 'IO2'), 'left70');
  assert.equal(slot(template, 'USB'), 'right270');
  assert.equal(slot(template, 'CAN'), 'bottom30');
  assert.ok(!template.logicalPorts.some(p => p.name === 'CNC'));
});

test('an older board takes the new slots once: wires kept, the unwired CNC pin gone', () => {
  const board = oldBoard();
  assert.equal(relayoutBoard(board, template, null), true);
  assert.equal(slot(board, 'IO4'), slot(template, 'IO4'));
  assert.equal(slot(board, 'USB'), 'right270');
  assert.equal(slot(board, 'CNC'), null);
  assert.equal(board.ports.find(p => p.id === 'p-IO4').id, 'p-IO4', 'the wired pin keeps its id, so its wire stays');
  assert.equal(board.geometry.height, template.geometry.height);
  // Once: a slot moved afterwards stays where the user put it.
  board.ports.find(p => p.id === 'p-IO4').offset = 999;
  assert.equal(relayoutBoard(board, template, null), false);
  assert.equal(board.ports.find(p => p.id === 'p-IO4').offset, 999);
});

test('a pin the module dropped stays while a wire is on it', () => {
  const board = oldBoard();
  board.children.connections.set('cnc', { sourceBlockId: 'y', sourcePortId: 'y-out', targetBlockId: 'esp', targetPortId: 'p-CNC' });
  relayoutBoard(board, template, null);
  assert.ok(board.logicalPorts.some(p => p.name === 'CNC'));
});
