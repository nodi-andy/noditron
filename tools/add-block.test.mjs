import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseNodesOutput, moduleNameFor, canNeighbours, NODE_TYPE_MODULES, MODULE_NAMES, canonicalModuleName } from '../client/src/moduleDiscovery.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// The Add Block window places a board by what it says about itself and
// wires in the neighbours it hears on CAN (see client/src/addBlockDialog.js).

test('nodes output is read line by line: type, id, optional name, version, self or how it was heard', () => {
  const nodes = parseNodesOutput([
    'logic a1d148c4 esp32-s3 v1.2 self',
    'cnc 0dd04644 CNC v1.4 seen 0s ago via can',
    'logic 1b2c3d4e v1.2 seen 3s ago via wifi',
    'cnc 85568abc CNC v1.4 seen 1s ago via can board=esp32s3-2io',
    'ok',
    '[CAN] tx logic a1d148c4 esp32-s3 v1.2 self',
  ]);
  assert.deepEqual(nodes, [
    { type: 'logic', id: 'a1d148c4', name: 'esp32-s3', version: '1.2', self: true, ageS: null, via: null, board: null },
    { type: 'cnc', id: '0dd04644', name: 'CNC', version: '1.4', self: false, ageS: 0, via: 'can', board: null },
    { type: 'logic', id: '1b2c3d4e', name: '', version: '1.2', self: false, ageS: 3, via: 'wifi', board: null },
    { type: 'cnc', id: '85568abc', name: 'CNC', version: '1.4', self: false, ageS: 1, via: 'can', board: 'esp32s3-2io' },
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

test('a board is placed as the module for its hardware and firmware; without a hardware id, by its USB chip', () => {
  assert.equal(moduleNameFor('cnc', { board: 'esp32s3-2io' }), 'esp32s3-2io-cnc');
  assert.equal(moduleNameFor('logic', { board: 'esp32s3-8io' }), 'esp32s3-8io-logic');
  assert.equal(moduleNameFor('logic', { board: 'esp32-devkit', nativeUsb: true }), 'esp32-devkit-logic', 'the board\'s own word wins');
  assert.equal(moduleNameFor('cnc', { board: 'no-such-board' }), 'esp32s3-2io-cnc', 'an unknown hardware id falls back');
  assert.equal(moduleNameFor('cnc'), 'esp32s3-2io-cnc');
  assert.equal(moduleNameFor('cnc', { nativeUsb: false }), 'esp32-devkit-cnc');
  assert.equal(moduleNameFor('logic', { nativeUsb: true }), 'esp32s3-8io-logic');
  assert.equal(moduleNameFor('logic', { nativeUsb: null }), 'esp32s3-8io-logic'); // over WiFi: nothing to tell by
  assert.equal(moduleNameFor('logic', { nativeUsb: false }), 'esp32-devkit-logic');
  assert.equal(moduleNameFor('something-else'), null);
  assert.deepEqual(NODE_TYPE_MODULES, { cnc: 'esp32s3-2io-cnc', logic: 'esp32s3-8io-logic' });
  assert.deepEqual(MODULE_NAMES, ['esp32-devkit-logic', 'esp32-devkit-cnc', 'esp32s3-2io-logic', 'esp32s3-2io-cnc', 'esp32s3-8io-logic', 'esp32s3-8io-cnc']);
  assert.equal(canonicalModuleName('esp32-s3-devkit'), 'esp32s3-8io-logic', 'the old names still resolve');
  assert.equal(canonicalModuleName('esp32-cnc'), 'esp32-devkit-cnc');
  assert.equal(canonicalModuleName('esp32s3-2io-cnc'), 'esp32s3-2io-cnc');
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
  assert.deepEqual(labels, ['Logic', 'Data', 'Time & output', 'Board I/O', 'Communication']);
  const kinds = [...source.matchAll(/entry\('#[0-9a-f]{6}', '[^']+', '([^']+)'/g)].map((m) => m[1]);
  assert.equal(new Set(kinds).size, kinds.length, 'no kind twice');
  assert.ok(kinds.includes('digital-io') && !kinds.includes('cnc-module'), 'a board itself is a module, never a palette entry');
  assert.ok(kinds.includes('can'));
  // The CNC driver block: in the palette, offered only where a board's
  // allowedChildKinds names it (see containerRestrictions.kindOffered).
  assert.ok(kinds.includes('cnc'));
  // One Gate, and it is the Route (the boolean `gate` never ran on a
  // board); Serial and I2C are one block each, both ways, beside CAN; a
  // Delay paces a loop that answers its own echo.
  assert.ok(kinds.includes('route') && !kinds.includes('gate'));
  assert.ok(/entry\('#[0-9a-f]{6}', 'Gate', 'route'/.test(source));
  assert.ok(kinds.includes('serial') && kinds.includes('i2c') && !['serialin', 'i2cout', 'i2cin'].some((k) => kinds.includes(k)));
  assert.ok(kinds.includes('delay'));
});

test('nodes from a current firmware say noditron, and carry the names they announce', () => {
  const nodes = parseNodesOutput([
    'noditron 855691c0 joystick v1.2 self board=esp32s3-2io',
    'noditron 85568abc cnc v1.2 seen 0s ago via can board=esp32s3-2io',
    'noditron 85569aec v1.2 seen 3s ago via can board=esp32s3-2io',
    'logic 12345678 v1.1 seen 1s ago via wifi',
  ]);
  assert.deepEqual(nodes.map((n) => [n.type, n.id, n.name, n.self]), [
    ['logic', '855691c0', 'joystick', true],
    ['logic', '85568abc', 'cnc', false],
    ['logic', '85569aec', '', false],
    ['logic', '12345678', '', false],
  ]);
});
