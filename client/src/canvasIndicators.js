// Draws every "intelligent" block's own indicator directly into nodigraph's
// own canvas paint (see main.js's window.nodigraphDrawBlock hook, and
// SceneRenderer's own doc on it) rather than a separately-timed DOM
// overlay. That distinction is the whole point: a DOM element's position
// is only ever as fresh as whatever last computed it, so during a pan/
// zoom/drag — which redraws the canvas every single frame nodigraph's own
// render loop runs — an overlay updated on a plain interval visibly lags
// and drifts out of alignment. Drawing inside onDrawBlock instead runs in
// the *same* paint, with the *same* already-camera-transformed `ctx`
// nodigraph just used to draw the block itself: zero extra lag, zero
// separate coordinate math, by construction, not by careful timing.
//
// Every block's appearance — Bool included — comes from that block's own
// `render` prop, no exceptions: this file draws *nothing* on its own
// authority. Select any block, open its Inspector "Logic" tab (see
// logicTab.js), and the Render field is genuinely what's on screen for it,
// editable the same way for every kind. The only thing still special-cased
// here is *interaction*: a Bool block's indicator also answers clicks (see
// the pointerdown listener below), because flipping a value is a
// privileged action a sandboxed render function was never meant to
// trigger — drawing and clicking are separate concerns, and only the
// second one is kind-specific.
//
// Block *values* still update on runtime.js's own 100ms timer (see
// getLastResult) — only *position* needed to move to every frame; how
// often the numbers themselves change is a separate, much less
// perceptible question.
import { kindOf, getLastResult } from './runtime.js';

const RADIUS = 9;
const OFF_FILL = '#3a3f2e';
const EDGE_STROKE = '#1c2431';
const ERROR_FILL = '#e5484d';
const DEFAULT_ON_FILL = '#3ecf5d';

function drawDot(ctx, x, y, on, onFill) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = on ? onFill : OFF_FILL;
  if (on) {
    ctx.shadowColor = onFill;
    ctx.shadowBlur = 10;
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = EDGE_STROKE;
  ctx.stroke();
  ctx.restore();
}

// Top-right corner of the block, not dead-center — the block's own name
// label already sits centered (see nodigraph's BlockRenderer.drawBlock),
// and a corner indicator reads as a status light without fighting it. Also
// where a Bool's click-to-toggle hit-tests against (see below) — the same
// spot regardless of what its own render function actually draws there.
function indicatorCenter(block) {
  return { x: block.geometry.x + block.geometry.width - 20, y: block.geometry.y + 20 };
}

const compiledCache = new Map(); // blockId -> { source, fn }
function compiledRenderFn(blockId, source) {
  const cached = compiledCache.get(blockId);
  if (cached && cached.source === source) return cached.fn;
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('ctx', 'block', 'inputs', 'outputs', 'helpers', source);
  } catch (err) {
    fn = () => {
      throw err;
    };
  }
  compiledCache.set(blockId, { source, fn });
  return fn;
}

// Returns a `(ctx, block) => void` draw step — main.js composes this with
// htmlOverlay.js's and dialogSystem.js's own draw steps into a single
// window.nodigraphDrawBlock, since nodigraph only ever calls one such hook
// per block per frame (see SceneRenderer.js).
export function installCanvasIndicators(nodigraph) {
  function drawBlock(ctx, block) {
    const renderSource = block.props?.find((p) => p.name === 'render')?.value;
    if (!renderSource || !String(renderSource).trim()) return;

    const result = getLastResult();
    const inputs = result.inputsByBlock.get(block.id) || {};
    const outputs = result.outputsByBlock.get(block.id) || {};
    const { x, y } = indicatorCenter(block);
    // `helpers.dot(on, color)` covers the common "just show a status
    // light" case in one line (`color` optional); the render function
    // still gets the real `ctx` too, for anything more elaborate (a
    // gauge, a sparkline, ...).
    const helpers = { dot: (on, color = DEFAULT_ON_FILL) => drawDot(ctx, x, y, on, color) };
    try {
      compiledRenderFn(block.id, String(renderSource))(ctx, block, inputs, outputs, helpers);
    } catch (err) {
      // A broken render function gets its own error marker rather than
      // either failing silently or throwing mid-paint and taking every
      // other block's own draw this frame down with it.
      drawDot(ctx, x, y, true, ERROR_FILL);
    }
  }

  // A capture-phase listener on window — not a click handler on some DOM
  // element — is what lets this run, and be able to stopPropagation(),
  // *before* nodigraph's own canvas pointerdown handler (a plain bubble
  // listener registered directly on the canvas, see InputRouter.js) ever
  // treats the same click as an ordinary press on the block underneath.
  // Hit-tests the same fixed corner every block's indicator lives at
  // (indicatorCenter), regardless of what that block's own render
  // function actually chose to draw there.
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      const canvas = document.getElementById('scene-canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      const world = nodigraph.camera.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);

      for (const block of nodigraph.project.listBlocks()) {
        if (kindOf(block) !== 'bool') continue;
        const { x, y } = indicatorCenter(block);
        if (Math.abs(world.x - x) <= RADIUS && Math.abs(world.y - y) <= RADIUS) {
          event.stopPropagation();
          event.preventDefault();
          const prop = block.props.find((p) => p.name === 'value');
          prop.value = Number(prop.value) >= 1 ? 0 : 1;
          nodigraph.renderLoop.requestRender();
          nodigraph.persist();
          return;
        }
      }
    },
    { capture: true },
  );

  return { drawBlock };
}
