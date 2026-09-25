import assert from 'node:assert/strict';
import test from 'node:test';

import { startRuntime, setChildOutput, clearChildOutputs, setBoundaryInput, getPortValue, getBlockOutputs, getLastResult } from '../client/src/runtime.js';

// A board's children are not run by the browser (the firmware owns them),
// so a host reports what it knows instead: what the board's output pins
// and USB link carry is what the child wired to them puts out, and what
// its input pins carry is what the level sees on them. Both must be
// readable tree-wide (wire colours, indicators) and, when the board is
// the level being edited, in the current result too.

function block(id, name, ports) {
  return {
    id, name, props: [{ name: 'noditronKind', value: 'timer' }], children: null,
    logicalPorts: ports.map(([n, d]) => ({ id: `${id}:${n}`, name: n, direction: d })),
    ports: ports.map(([n]) => ({ id: `${id}:${n}:pin`, logicalId: `${id}:${n}` })),
    geometry: { x: 0, y: 0, width: 100, height: 40 },
  };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('host-reported values stand in for an evaluation of a firmware-owned level', async () => {
  const timer = block('timer', 'Timer', [['out', 'out']]);
  const board = block('board', 'esp32-S3', [['DI1', 'in'], ['DO1', 'out']]);
  board.children = { blocks: new Map([[timer.id, timer]]), connections: new Map() };
  const root = { id: 'root', children: { blocks: new Map([[board.id, board]]), connections: new Map() } };
  const nodigraph = { project: { rootBlock: root, getContainerBlock: () => board } };

  const stop = startRuntime(nodigraph, () => {}, 20, (container) => {
    if (container !== board) return undefined;
    setBoundaryInput(board.id, 'board:DI1:pin', true);
    setChildOutput(board.id, timer.id, 'timer:out:pin', true);
    return false; // the firmware runs this level, not the browser
  });
  try {
    await tick(60);
    assert.equal(getPortValue(timer.id, 'timer:out:pin'), true, 'the Timer reads what the board reports for its pin');
    assert.deepEqual(getBlockOutputs(timer), { out: true });
    assert.equal(getPortValue(board.id, 'board:DI1:pin'), true, 'the input pin is readable from inside');
    assert.deepEqual(getLastResult().outputsByBlock.get(timer.id), { out: true }, 'the edited level result carries it too');
    clearChildOutputs(board.id);
  } finally {
    stop();
  }
});
