// Every block on a level has a name of its own: the second "Match" becomes
// "Match 2", the third "Match 3". With three blocks called Match, a note
// about "Match", a console line or a wire label said nothing about which
// one. The first of a name keeps it; a number goes to the ones after it.
//
// Boards keep their names (they are the node's name on the bus), and so do
// the parts inside blocks whose parts are read by name — a CNC's settings,
// a Timer's T_ON / T_OFF, a State's latch.
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';

const BOARD_KINDS = new Set(['esp32-devkit']);
const NAMED_PARTS = new Set(['cnc', 'timer', 'state', 'cnc-home-axis']);

const kindOf = (block) => (block.props || []).find((p) => p.name === 'noditronKind')?.value;

export function uniquifyNames(level) {
  if (!level?.blocks) return false;
  let changed = false;
  // Every name already in use is kept by its first holder (a board first):
  // only the repeats are renamed, to numbers nobody holds.
  const blocks = [...level.blocks.values()];
  const keeps = new Set();
  const taken = new Set();
  for (const block of [...blocks.filter((b) => BOARD_KINDS.has(kindOf(b))), ...blocks]) {
    if (taken.has(block.name)) continue;
    taken.add(block.name);
    keeps.add(block);
  }
  for (const block of blocks) {
    const base = String(block.name || '').trim();
    if (!keeps.has(block) && !BOARD_KINDS.has(kindOf(block)) && base) {
      let k = 2;
      while (taken.has(`${base} ${k}`)) k += 1;
      block.name = `${base} ${k}`;
      taken.add(block.name);
      block.description = serializeBlockDescription(block);
      changed = true;
    }
    if (block.children && !NAMED_PARTS.has(kindOf(block)) && uniquifyNames(block.children)) changed = true;
  }
  return changed;
}

// A port that ships hidden (a Data's `write`, a Gate's out3/out4) is shown
// once a wire uses it — a wire into a hidden port is drawn over its
// neighbour's, so a Data fed on `in` and `write` from one output looked
// like one wire into `in`. Whole tree; true when anything was revealed.
export function revealWiredPorts(level) {
  if (!level?.blocks) return false;
  let changed = false;
  const reveal = (blockId, portId) => {
    const block = level.blocks.get(blockId);
    const pin = block && (block.ports || []).find((p) => p.id === portId);
    const logical = pin && (block.logicalPorts || []).find((l) => l.id === pin.logicalId);
    if (!logical?.hidden) return;
    delete logical.hidden;
    block.description = serializeBlockDescription(block);
    changed = true;
  };
  for (const conn of level.connections?.values?.() || []) {
    reveal(conn.sourceBlockId, conn.sourcePortId);
    reveal(conn.targetBlockId, conn.targetPortId);
  }
  for (const block of level.blocks.values()) if (block.children && revealWiredPorts(block.children)) changed = true;
  return changed;
}
