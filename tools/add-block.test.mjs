import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseNodesOutput, moduleNameFor, canNeighbours, NODE_TYPE_MODULES } from '../client/src/moduleDiscovery.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// The Add Block window places a board by what it says about itself and
// wires in the neighbours it hears on CAN (see client/src/addBlockDialog.js).

test('nodes output is read line by line: type, id, optional name, version, self or how it was heard', () => {
  const nodes = parseNodesOutput([
    'logic a1d148c4 esp32-s3 v1.2 self',
    'cnc 0dd04644 CNC v1.4 seen 0s ago via can',
    'logic 1b2c3d4e v1.2 seen 3s ago via wifi',
    'ok',
    '[CAN] tx logic a1d148c4 esp32-s3 v1.2 self',
  ]);
  assert.deepEqual(nodes, [
    { type: 'logic', id: 'a1d148c4', name: 'esp32-s3', version: '1.2', self: true, ageS: null, via: null },
    { type: 'cnc', id: '0dd04644', name: 'CNC', version: '1.4', self: false, ageS: 0, via: 'can' },
    { type: 'logic', id: '1b2c3d4e', name: '', version: '1.2', self: false, ageS: 3, via: 'wifi' },
  ]);
});

test('only nodes heard on the CAN bus are placed beside the board and wired to it', () => {
  const nodes = parseNodesOutput([
    'cnc 0dd04644 CNC v1.4 self',
    'logic a1d148c4 esp32-s3 v1.2 seen 1s ago via can',
    'logic 1b2c3d4e other v1.2 seen 3s ago via wifi',
    'node deadbeef v0.1 seen 9s ago via can',
  ]);
  assert.deepEqual(canNeighbours(nodes).map((n) => [n.type, n.id]), [['logic', 'a1d148c4']]);
});

test('a board is placed as the module its kind names; a logic board on a bridge chip is the classic DevKit', () => {
  assert.equal(moduleNameFor('cnc'), 'esp32-cnc');
  assert.equal(moduleNameFor('logic', { nativeUsb: true }), 'esp32-s3-devkit');
  assert.equal(moduleNameFor('logic', { nativeUsb: null }), 'esp32-s3-devkit'); // over WiFi: nothing to tell by
  assert.equal(moduleNameFor('logic', { nativeUsb: false }), 'esp32-devkit');
  assert.equal(moduleNameFor('something-else'), null);
  assert.deepEqual(NODE_TYPE_MODULES, { cnc: 'esp32-cnc', logic: 'esp32-s3-devkit' });
});

test('nodigraph\'s + button opens the window instead of adding an empty block, and the side palette is gone', () => {
  const dialog = read('../client/src/addBlockDialog.js');
  assert.match(dialog, /getElementById\('fab-add-block'\)/);
  assert.match(dialog, /stopImmediatePropagation\(\)/);
  assert.match(dialog, /\{ capture: true \}/);
  const html = read('../client/index.html');
  assert.ok(!html.includes('id="noditron-palette"'), 'no palette host in index.html');
  const main = read('../client/src/main.js');
  assert.ok(!main.includes('mountPalette') && !main.includes('mountLibrary'), 'main.js no longer mounts a palette or library panel');
  assert.match(main, /installAddBlockDialog\(nodigraph\)/);
  const library = read('../client/src/library.js');
  assert.ok(!library.includes('Add from library'), 'the library browse dialog is gone');
  assert.match(library, /export async function resolveModuleByName/);
});

test('every primitive is in a group, and each group entry names a kind the container filter can check', async () => {
  const palette = read('../client/src/palette.js');
  const start = palette.indexOf('export function paletteGroups(nodigraph)');
  assert.ok(start > 0);
  const source = palette.slice(start);
  const labels = [...source.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Logic', 'Data', 'Time & output', 'Board I/O']);
  const kinds = [...source.matchAll(/entry\('#[0-9a-f]{6}', '[^']+', '([^']+)'/g)].map((m) => m[1]);
  assert.equal(new Set(kinds).size, kinds.length, 'no kind twice');
  assert.ok(kinds.includes('digital-io') && kinds.includes('cnc') === false, 'the CAN block is the board I/O kind "can", the board itself is a module');
  assert.ok(kinds.includes('can'));
});
