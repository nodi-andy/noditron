// A block's own `html` prop — a plain JS function body, `(container,
// block, inputs, outputs, helpers) => void`, editable in the Inspector's
// Logic tab (see logicTab.js) exactly like `fn`/`render` — gives a block
// real DOM to draw into instead of hand-drawn canvas shapes. That's the
// difference from canvasIndicators.js: a `render` function can *approximate*
// a slider by drawing a rounded rect and a circle, but it can't give you an
// actual <input type=range> with real drag physics and keyboard support.
//
// Positioning still follows the same rule the lag fix established
// (see canvasIndicators.js's own doc, and SceneRenderer.js): this container
// is repositioned from inside window.nodigraphDrawBlock, every frame, using
// the camera nodigraph just used to draw the block itself — not on
// runtime.js's separate 100ms timer, which is what caused the original
// "overlays are misplaced if the screen moves" bug. Only *existence*
// (removing a container for a deleted block, or one whose `html` prop got
// cleared) is cheap enough to leave on that slower timer — see prune().
import { getLastResult } from './runtime.js';

const LAYER_ID = 'noditron-html-layer';

function ensureLayer() {
  let layer = document.getElementById(LAYER_ID);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    document.body.appendChild(layer);
  }
  return layer;
}

const compiledCache = new Map(); // blockId -> { source, fn }
function compiledHtmlFn(blockId, source) {
  const cached = compiledCache.get(blockId);
  if (cached && cached.source === source) return cached.fn;
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('container', 'block', 'inputs', 'outputs', 'helpers', source);
  } catch (err) {
    fn = (container) => {
      container.textContent = `HTML error: ${err.message}`;
    };
  }
  compiledCache.set(blockId, { source, fn });
  return fn;
}

// Returns { drawBlock, prune } — drawBlock composes into the shared
// window.nodigraphDrawBlock (see main.js); prune is called separately, off
// runtime.js's own tick, to remove containers for blocks that no longer
// exist or no longer opt into `html`.
export function installHtmlOverlay(nodigraph, openDialogFor) {
  const layer = ensureLayer();
  const containers = new Map(); // blockId -> HTMLElement

  function containerFor(blockId) {
    let el = containers.get(blockId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'noditron-html-block';
      layer.appendChild(el);
      containers.set(blockId, el);
    }
    return el;
  }

  function drawBlock(ctx, block) {
    const source = block.props?.find((p) => p.name === 'html')?.value;
    if (!source || !String(source).trim()) return;

    const canvas = document.getElementById('scene-canvas');
    const rect = canvas.getBoundingClientRect();
    const { camera } = nodigraph;
    const topLeft = camera.worldToScreen(block.geometry.x, block.geometry.y);
    const el = containerFor(block.id);
    el.style.left = `${rect.left + topLeft.x}px`;
    el.style.top = `${rect.top + topLeft.y}px`;
    el.style.width = `${block.geometry.width * camera.zoom}px`;
    el.style.height = `${block.geometry.height * camera.zoom}px`;

    const result = getLastResult();
    const inputs = result.inputsByBlock.get(block.id) || {};
    const outputs = result.outputsByBlock.get(block.id) || {};
    // `openDialog()` lets html content put its own settings/gear button
    // wherever it wants (see dialogSystem.js) — a real DOM element with a
    // real click handler, no canvas hit-testing hack needed for blocks
    // that already have DOM to work with.
    const helpers = {
      openDialog: () => openDialogFor(block),
      setProp(name, value) {
        const prop = block.props.find((p) => p.name === name);
        if (prop) {
          prop.value = value;
          nodigraph.persist();
        }
      },
    };
    try {
      compiledHtmlFn(block.id, String(source))(el, block, inputs, outputs, helpers);
    } catch (err) {
      el.textContent = `HTML error: ${err.message}`;
    }
  }

  function prune(liveBlockIds) {
    for (const [id, el] of containers) {
      const block = liveBlockIds.get ? liveBlockIds.get(id) : null;
      const stillWantsHtml = block && String(block.props?.find((p) => p.name === 'html')?.value || '').trim();
      if (!stillWantsHtml) {
        el.remove();
        containers.delete(id);
      }
    }
  }

  return { drawBlock, prune };
}
