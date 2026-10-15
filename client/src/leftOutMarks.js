// A ⚠ on every drawn block inside a board that the board will not run as
// drawn — what the compiler's notes say about it (serialConsole.noteBlock).
// Those notes used to reach only the browser console, so a drawing could
// look complete while half of it never left the page. Recompiled now and
// then, not per frame: a compile walks the whole board. A click on the
// mark shows its note.
import * as devkitCircuit from './devkitCircuit.js';
import * as serialConsole from './serialConsole.js';
import { showToast } from '/nodigraph/src/ui/Toast.js';

const RECHECK_MS = 1500;
const SIZE = 18;
const FILL = '#f5a524';
const EDGE = '#1c2431';

// Top-left corner, clear of the status light canvasIndicators draws at
// the top-right.
function markOrigin(block) {
  return { x: block.geometry.x + 6, y: block.geometry.y + 6 };
}

// The wires into a Data's `write` that come from an output also wired to
// its `in` (see serialConsole.buildWiredDesign's note on them).
function doubledWrites(board, block) {
  const conns = [...(board?.children?.connections?.values?.() || [])].filter((c) => c.targetBlockId === block.id);
  const nameOf = (portId) => {
    const pin = (block.ports || []).find((p) => p.id === portId);
    return (block.logicalPorts || []).find((l) => l.id === pin?.logicalId)?.name;
  };
  const triggers = new Set(conns.filter((c) => nameOf(c.targetPortId) === 'in').map((c) => `${c.sourceBlockId}:${c.sourcePortId}`));
  return conns.filter((c) => nameOf(c.targetPortId) === 'write' && triggers.has(`${c.sourceBlockId}:${c.sourcePortId}`)).map((c) => c.id);
}

export function installLeftOutMarks(nodigraph, { openDialog = null } = {}) {
  let marked = new Map(); // block id -> [note]
  let boardOf = new Map(); // block id -> the board it is in
  let checkedAt = 0;

  function recheck() {
    const next = new Map();
    const nextBoard = new Map();
    for (const { block, level } of devkitCircuit.collectBoardBlocks(nodigraph.project.rootBlock.children)) {
      const notes = [];
      notes.byBlock = new Map();
      try {
        devkitCircuit.buildDevkitDesign(block, level, { notes });
      } catch {
        // A drawing the compiler refuses outright says so on Save; nothing
        // to mark block by block.
      }
      for (const [id, list] of notes.byBlock) {
        next.set(id, list);
        nextBoard.set(id, block);
      }
    }
    boardOf = nextBoard;
    const changed = next.size !== marked.size || [...next].some(([id, list]) => String(marked.get(id)) !== String(list));
    marked = next;
    if (changed) nodigraph.renderLoop.requestRender();
  }

  function drawBlock(ctx, block) {
    const now = Date.now();
    if (now - checkedAt > RECHECK_MS) {
      checkedAt = now;
      recheck();
    }
    if (!marked.has(block.id)) return;
    const { x, y } = markOrigin(block);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + SIZE / 2, y);
    ctx.lineTo(x + SIZE, y + SIZE);
    ctx.lineTo(x, y + SIZE);
    ctx.closePath();
    ctx.fillStyle = FILL;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = EDGE;
    ctx.stroke();
    ctx.fillStyle = EDGE;
    ctx.font = `bold ${SIZE * 0.6}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('!', x + SIZE / 2, y + SIZE - 3);
    ctx.restore();
  }

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || !marked.size) return;
      const canvas = document.getElementById('scene-canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      const world = nodigraph.camera.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      for (const block of nodigraph.project.listBlocks()) {
        const notes = marked.get(block.id);
        if (!notes) continue;
        const { x, y } = markOrigin(block);
        if (world.x < x || world.x > x + SIZE || world.y < y || world.y > y + SIZE) continue;
        event.stopPropagation();
        event.preventDefault();
        // A board whose firmware is what stands in the way gets the way
        // out on the note itself: its dialog, where the update is offered.
        const board = boardOf.get(block.id);
        const oldFirmware = board && !serialConsole.runsWires(devkitCircuit.boardBuildOf(board));
        const actions = oldFirmware && openDialog ? [{ label: 'Update firmware', onClick: () => openDialog(board) }, { label: 'OK' }] : [];
        // A Data with one output wired into both its `in` and its `write`:
        // the fix is one click, so it is offered as one.
        const doubled = doubledWrites(board, block);
        if (doubled.length) {
          actions.push({ label: 'Delete the write wire', onClick: () => {
            for (const id of doubled) board.children.connections.delete(id);
            nodigraph.persist();
            nodigraph.renderLoop.requestRender();
            checkedAt = 0;
          } }, { label: 'Keep' });
        }
        showToast(notes.join(' '), { actions, autoDismissMs: oldFirmware || doubled.length ? 0 : 8000 });
        return;
      }
    },
    { capture: true },
  );

  return { drawBlock, count: () => marked.size };
}
