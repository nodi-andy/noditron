// What a board's own blocks are doing, shown on the blocks drawn for them.
// The browser does not run a board's circuit (see main.js's
// syncLiveDigitalIO), so without this a block inside it shows only what
// its pins tell: an OR feeding a Gate's sel had no value, and the Gate
// said "no sel" while the board was routing. A board whose firmware runs
// wires (serialConsole.buildWiredDesign) reports each block's outputs as
// they fire — its trace, `{"type":"blk","id":N,"o":port,"v":value}` — and
// the design it holds names the drawn block behind each id (`ref`).
//
// The trace is asked for only while the board's circuit is on screen —
// you are inside the board, or its face is drawn open — and the board is
// on this page's own link; the firmware lets it lapse a few seconds after
// the last ask (see conucon's traceOn), so a board nobody is looking at,
// or a page that went away, leaves the console quiet.
import * as serialConsole from './serialConsole.js';
import * as devkitCircuit from './devkitCircuit.js';
import { isLevelOpen } from '/nodigraph/src/render/SubPreviewRenderer.js';

const ASK_EVERY_MS = 2000;
const MAP_EVERY_MS = 1000;
// A Match fires every matching row in one go; rows that did not fire in
// the same go are no longer what it put out.
const SAME_FIRE_MS = 30;
const BOOLEAN_KINDS = new Set(['and', 'or', 'not', 'delay', 'digital-io']);

const kindOf = (block) => (block?.props || []).find((p) => p.name === 'noditronKind')?.value;

function outputPinIds(block) {
  const outs = (block.logicalPorts || []).filter((l) => l.direction === 'out');
  return outs.map((l) => (block.ports || []).find((p) => p.logicalId === l.id)?.id || null);
}

export function createBoardTrace(nodigraph) {
  const boards = new Map(); // board id -> state

  function stateFor(board) {
    let state = boards.get(board.id);
    if (!state) {
      state = {
        values: new Map(), // `${ref}:${pinId}` -> { ref, pinId, value, at }
        refOf: new Map(), // firmware id -> drawn block id
        mappedAt: 0,
        askedAt: 0,
        asking: false,
        unsubscribe: serialConsole.subscribeTrace(board.id, (message) => take(board, message)),
      };
      boards.set(board.id, state);
    }
    return state;
  }

  // The firmware ids of the circuit as drawn — the same numbering the
  // board was sent, as long as the drawing is what it holds. A drawing
  // changed since the last save maps nothing: its ids may not be the
  // board's any more, and a value shown on the wrong block is worse than
  // none.
  function remap(board, state, level) {
    state.refOf.clear();
    if (devkitCircuit.isDevkitDirty(board, level)) return;
    let design = null;
    try {
      design = devkitCircuit.buildDevkitDesign(board, level);
    } catch {
      return;
    }
    if (!Array.isArray(design?.wires)) return;
    for (const b of design.blocks) if (b.ref) state.refOf.set(b.id, b.ref);
  }

  function take(board, message) {
    const state = boards.get(board.id);
    if (!state) return;
    const ref = state.refOf.get(message.id);
    const block = ref && board.children?.blocks?.get(ref);
    if (!block || message.o === undefined) return;
    const pins = outputPinIds(block);
    const pinId = pins[Number(message.o)] ?? (Number(message.o) === 0 ? pins[0] : null);
    if (!pinId) return;
    const text = String(message.v ?? '');
    const value = BOOLEAN_KINDS.has(kindOf(block)) ? (text !== '' && text !== '0' && text !== 'LOW') : text;
    const now = Date.now();
    if (kindOf(block) === 'croute' || kindOf(block) === 'route') {
      for (const [key, entry] of state.values) {
        if (entry.ref === ref && entry.pinId !== pinId && now - entry.at > SAME_FIRE_MS) state.values.delete(key);
      }
    }
    state.values.set(`${ref}:${pinId}`, { ref, pinId, value, at: now });
  }

  function onScreen(board) {
    let level = nodigraph.project.getContainerBlock?.();
    // Inside the board, or inside something inside it.
    const inside = (block, id) => block?.id === id || [...(block?.children?.blocks?.values?.() || [])].some((child) => inside(child, id));
    if (level && inside(board, level.id)) return true;
    return isLevelOpen(board, nodigraph.camera?.zoom ?? 1);
  }

  // Once per tick for a live board (see main.js): keep the trace asked for
  // while it is seen, and lay what it said over the board's children.
  function apply(board, level, setChildOutput) {
    const state = stateFor(board);
    const now = Date.now();
    const direct = !serialConsole.bridgeFor(board.id);
    const wired = serialConsole.runsWires(devkitCircuit.boardBuildOf(board));
    if (!direct || !wired || !onScreen(board)) {
      if (state.askedAt) {
        state.askedAt = 0;
        state.values.clear();
        serialConsole.traceOff(board.id).catch(() => {});
      }
      return;
    }
    if (now - state.mappedAt > MAP_EVERY_MS) {
      state.mappedAt = now;
      remap(board, state, level);
    }
    if (!state.asking && now - state.askedAt > ASK_EVERY_MS) {
      state.asking = true;
      state.askedAt = now;
      serialConsole.traceOn(board.id).catch(() => {}).finally(() => { state.asking = false; });
    }
    if (!state.refOf.size) return;
    for (const { ref, pinId, value } of state.values.values()) setChildOutput(board.id, ref, pinId, value);
  }

  function forget(boardId) {
    const state = boards.get(boardId);
    if (!state) return;
    state.unsubscribe();
    boards.delete(boardId);
  }

  return { apply, forget };
}
