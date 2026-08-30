// A block's own `dialog` prop — a plain JS function body, `(container,
// block, props, outputs, helpers) => void`, editable in the Inspector's
// Logic tab (see logicTab.js) alongside `fn`/`render`/`html` — builds a
// settings panel shown in a modal, on demand. Unlike `html` (positioned
// every frame over the block on canvas — see htmlOverlay.js), a dialog
// isn't tied to the block's on-canvas position at all, so it's just a
// normal centered overlay with no per-frame work. `outputs` is a one-time
// snapshot taken when the dialog opens (the block's own last computed
// values, from runtime.js's own getLastResult — the exact same numbers its
// `html`/`render` are already drawing from) — handy for a dialog that
// wants to show what a block actually produced, like Weather's own raw API
// response, without needing its own separate fetch/state.
//
// Two ways to open one:
//  - a block with its own `html` calls `helpers.openDialog()` on whatever
//    element it wants (a real button, a real click handler — see
//    htmlOverlay.js's own helpers);
//  - a block with a `dialog` but no `html` gets a small gear drawn in its
//    own top-left corner (drawBlock below), clickable the same
//    capture-phase way canvasIndicators.js's own dot toggles are.
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { getLastResult } from './runtime.js';
import * as serialFlash from './serialFlash.js';
import * as serialConsole from './serialConsole.js';

const HOST_ID = 'noditron-dialog-host';
const GEAR_RADIUS = 8;

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.hidden = true;
    document.body.appendChild(host);
  }
  return host;
}

function propsObject(block) {
  const obj = {};
  for (const p of block.props || []) obj[p.name] = p.value;
  return obj;
}

function hasSource(block, propName) {
  return Boolean(String(block.props?.find((p) => p.name === propName)?.value || '').trim());
}

// Top-left, not the render indicator's top-right (see canvasIndicators.js)
// — a block can have both a status dot and a settings gear at once without
// them fighting for the same corner.
function gearCenter(block) {
  return { x: block.geometry.x + 16, y: block.geometry.y + 16 };
}

// A module-level reference to the installed instance's own openDialog —
// lets logicTab.js's "Open dialog" preview button reuse the exact same
// modal without needing `nodigraph` threaded through the Inspector's
// extraTabs render signature (which only carries {block, project,
// requestRender, persist} — see InspectorPanel.mountInspector).
let installed = null;
export function openDialogPreview(block) {
  installed?.openDialog(block);
}

export function installDialogSystem(nodigraph) {
  const host = ensureHost();

  function close() {
    host.hidden = true;
    host.innerHTML = '';
  }

  function openDialog(block) {
    const source = block.props?.find((p) => p.name === 'dialog')?.value;
    if (!source || !String(source).trim()) return;

    host.innerHTML = '';
    host.hidden = false;

    const backdrop = document.createElement('div');
    backdrop.className = 'noditron-dialog-backdrop';
    backdrop.addEventListener('click', close);

    const panel = document.createElement('div');
    panel.className = 'noditron-dialog-panel';
    panel.addEventListener('click', (event) => event.stopPropagation());

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'noditron-dialog-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', close);

    const body = document.createElement('div');
    body.className = 'noditron-dialog-body';

    panel.append(closeBtn, body);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);

    const helpers = {
      close,
      setProp(name, value) {
        const prop = block.props.find((p) => p.name === name);
        if (!prop) return;
        prop.value = value;
        block.description = serializeBlockDescription(block);
        nodigraph.renderLoop.requestRender();
        nodigraph.persist();
      },
      // The live project, for a dialog doing something setProp can't —
      // adding/removing a whole port (Digital I/O's own direction switch,
      // for one), not just editing a value. Mirrors exactly what the
      // Inspector's own port-delete button does: remove the logical port,
      // then removeConnectionsForPort for each pin it took with it, so a
      // wire that pointed at a now-gone pin doesn't linger as a dangling
      // reference. refresh() is setProp's own render+persist tail end,
      // split out for exactly this case — a mutation that isn't a prop.
      project: nodigraph.project,
      refresh() {
        nodigraph.renderLoop.requestRender();
        nodigraph.persist();
      },
      // Generic Web Serial + esptool-js bridge (see serialFlash.js) — kept
      // as unspecial to any one block as fetchJson/fetchStatus already are
      // to `fn`: available to every dialog, meaningful only to whichever
      // block actually calls it. One session per block.id, so a dialog
      // reopened later (or a different ESP32-shaped block entirely) still
      // reaches its own still-open connection rather than someone else's.
      serial: {
        isSupported: serialFlash.isSupported,
        connect: (onLog) => serialFlash.connect(block.id, { onLog }),
        detectChip: (onLog) => serialFlash.detectChip(block.id, { onLog }),
        flash: (files, eraseAll, onProgress, onLog) => serialFlash.flash(block.id, files, { eraseAll, onProgress, onLog }),
        disconnect: () => serialFlash.disconnect(block.id),
        guessAddress: serialFlash.guessAddress,
        getSession: () => serialFlash.getSession(block.id),
        firmwarePresets: serialFlash.FIRMWARE_PRESETS,
        fetchPresetParts: serialFlash.fetchPresetParts,
      },
      // A separate bridge from `serial` above on purpose — this talks to a
      // *booted* board's own logicMod firmware over the plain-text console
      // it already runs during normal operation (see serialConsole.js),
      // over the exact same Web Serial connection `serial` above uses for
      // flashing — not a second link, no WiFi/network switch required.
      // Generic the same way `serial` is: meaningful only to whichever
      // block's dialog actually calls it.
      console: {
        identify: (opts) => serialConsole.identify(block.id, opts),
        readDesign: (opts) => serialConsole.readDesign(block.id, opts),
        sendDesign: (design, opts) => serialConsole.sendDesign(block.id, design, opts),
        buildMinimalDesign: serialConsole.buildMinimalDesign,
        close: () => serialConsole.closeConsole(block.id),
      },
    };

    const outputs = getLastResult().outputsByBlock.get(block.id) || {};
    try {
      // eslint-disable-next-line no-new-func
      new Function('container', 'block', 'props', 'outputs', 'helpers', String(source))(body, block, propsObject(block), outputs, helpers);
    } catch (err) {
      body.textContent = `Dialog error: ${err.message}`;
    }
  }

  // Fallback gear for a block that has a `dialog` but chose not to (or
  // has no reason to) also define `html` — drawn straight into nodigraph's
  // canvas paint the same way canvasIndicators.js draws its own indicator.
  function drawBlock(ctx, block) {
    if (!hasSource(block, 'dialog') || hasSource(block, 'html')) return;
    const { x, y } = gearCenter(block);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, GEAR_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#2c3644';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#8b93a3';
    ctx.stroke();
    ctx.fillStyle = '#c3c9d4';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚙', x, y + 1);
    ctx.restore();
  }

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
        if (!hasSource(block, 'dialog') || hasSource(block, 'html')) continue;
        const { x, y } = gearCenter(block);
        if (Math.abs(world.x - x) <= GEAR_RADIUS && Math.abs(world.y - y) <= GEAR_RADIUS) {
          event.stopPropagation();
          event.preventDefault();
          openDialog(block);
          return;
        }
      }
    },
    { capture: true },
  );

  const api = { drawBlock, openDialog };
  installed = api;
  return api;
}
