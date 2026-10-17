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
import { getLastResult, kindOf } from './runtime.js';
import * as serialFlash from './serialFlash.js';
import * as serialConsole from './serialConsole.js';
import * as devkitCircuit from './devkitCircuit.js';
import { socketPortsOf } from './socketLink.js';
import { reconcileWithDevice, loadFromDevice } from './deviceSync.js';
import { rememberedWifi } from './serialMemory.js';
import { mountCncPanel, readStatusReply } from './cncPanel.js';
import { mountCncControl } from './cncControl.js';

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

function isEsp32Devkit(block) {
  return block.props?.find((p) => p.name === 'noditronKind')?.value === 'esp32-devkit';
}

// Top-left, not the render indicator's top-right (see canvasIndicators.js)
// — a block can have both a status dot and a settings gear at once without
// them fighting for the same corner.
function gearCenter(block) {
  return isEsp32Devkit(block)
    ? { x: block.geometry.x + block.geometry.width - 16, y: block.geometry.y + 16 }
    : { x: block.geometry.x + 16, y: block.geometry.y + 16 };
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

  // The modal itself: backdrop, panel, close button, an empty body.
  function openModal({ wide = false } = {}) {
    host.innerHTML = '';
    host.hidden = false;

    const backdrop = document.createElement('div');
    backdrop.className = 'noditron-dialog-backdrop';
    backdrop.addEventListener('click', close);

    const panel = document.createElement('div');
    panel.className = wide ? 'noditron-dialog-panel noditron-cnc-panel' : 'noditron-dialog-panel';
    panel.addEventListener('click', (event) => event.stopPropagation());

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'noditron-dialog-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      close();
    });

    const body = document.createElement('div');
    body.className = 'noditron-dialog-body';

    panel.append(closeBtn, body);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);
    return { body, panel };
  }

  // What the CNC control needs of the board a block belongs to (see
  // cncPanel.js / cncControl.js): its shell, whether it has a link, and
  // the editor's program, kept on the board block.
  function cncLinkFor(block) {
    const board = devkitCircuit.findOwningBoard(nodigraph.project.rootBlock.children, block.id);
    if (!board) return null;
    const programProp = () => board.props.find((p) => p.name === 'cncProgram');
    return {
      board,
      shell: (line, shellOpts) => serialConsole.shell(board.id, line, shellOpts),
      isLinked: () => Boolean(serialFlash.getSession(board.id) || serialConsole.bridgeFor(board.id)),
      isBusy: () => serialFlash.isFlashing(board.id),
      program: String(programProp()?.value || ''),
      saveProgram: (text) => {
        const prop = programProp();
        if (prop && prop.value === text) return;
        if (prop) prop.value = text;
        else board.props.push({ id: `${board.id}:cncProgram`, name: 'cncProgram', kind: 'value', value: text });
        board.description = serializeBlockDescription(board);
        nodigraph.persist();
      },
    };
  }

  function mountControlFor(block, target) {
    const link = cncLinkFor(block);
    if (!link) {
      target.textContent = 'Place this block inside a board to drive its CNC.';
      return () => {};
    }
    return mountCncControl(target, { ...link, title: `${link.board.name || 'CNC'} · CNC` });
  }

  // The CNC control in a modal of its own, wide: the board's (or the
  // block's board's) machine, its gcode and its files.
  function openCncControl(block) {
    const { body } = openModal({ wide: true });
    mountControlFor(block, body);
  }

  function openDialog(block) {
    const source = block.props?.find((p) => p.name === 'dialog')?.value;
    if (!source || !String(source).trim()) return;
    const executableSource = kindOf(block) === 'esp32-devkit'
      ? String(source)
        .replace(
          /if \(!design\.blocks\.length\)\s*\{\s*log\('Nothing to send -- connect a supported circuit signal directly to DI, DO, or CAN\.'\);\s*\}\s*else\s*\{\s*/,
          '',
        )
        .replace(/(updateProgramSection\(\);)\s*}\s*}\s*catch \(err\)/, '$1\n    } catch (err)')
      : source;

    const { body } = openModal();

    const helpers = {
      close,
      setProp(name, value) {
        const prop = block.props.find((p) => p.name === name);
        if (!prop) return;
        // The same value again is no edit: on a board's own page every
        // persist is a write of the whole project to the board's flash.
        if (prop.value === value) return;
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
        // The same session over the air (see serialFlash.connectWifi):
        // `host` is the board's IP or name; the last one used is offered.
        connectWifi: (host, onLog) => serialFlash.connectWifi(block.id, host, { onLog }),
        rememberedWifi: () => rememberedWifi(block.id),
        linkKind: () => serialFlash.getSession(block.id)?.kind || (serialConsole.bridgeFor(block.id) ? 'can' : 'serial'),
        detectChip: (onLog) => serialFlash.detectChip(block.id, { onLog }),
        flash: (files, eraseAll, onProgress, onLog) => serialFlash.flash(block.id, files, { eraseAll, onProgress, onLog }),
        // True while this block's firmware install holds the port; the
        // dialog's own pollers (grbl state, connectivity) check it and skip
        // rather than reach for the console mid-write (see serialFlash.flash).
        isFlashing: () => serialFlash.isFlashing(block.id),
        // `forget` (true from a dialog's own Disconnect button) also drops
        // the remembered port, so the next load does not offer it again.
        disconnect: (forget) => serialFlash.disconnect(block.id, { forget: Boolean(forget) }),
        guessAddress: serialFlash.guessAddress,
        // A block online through another board (see canBridge.js) has a
        // session too, of kind 'can': its dialog opens on the connected path
        // and every console call goes through the bridge.
        getSession: () => serialFlash.getSession(block.id) || (serialConsole.bridgeFor(block.id) ? { kind: 'can', ...serialConsole.bridgeFor(block.id) } : null),
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
        buildMinimalDesign: (blocks, connections) => kindOf(block) === 'esp32-devkit'
          ? devkitCircuit.buildDevkitDesign(block, devkitCircuit.findContainingLevel(nodigraph.project.rootBlock.children, block.id))
          : serialConsole.buildMinimalDesign(blocks, connections),
        buildDevkitDesign: () => devkitCircuit.buildDevkitDesign(block, devkitCircuit.findContainingLevel(nodigraph.project.rootBlock.children, block.id)),
        devkitSnapshot: () => devkitCircuit.devkitSnapshot(block, devkitCircuit.findContainingLevel(nodigraph.project.rootBlock.children, block.id)),
        designSummary: (design) => devkitCircuit.summarizeDesign(design),
        // `design` is what was just sent (see devkitCircuit.markDevkitSent).
        markDevkitSent: (design) => {
          devkitCircuit.markDevkitSent(block, design);
          nodigraph.renderLoop.requestRender();
          nodigraph.persist();
        },
        isDirty: () => devkitCircuit.isDevkitDirty(block, devkitCircuit.findContainingLevel(nodigraph.project.rootBlock.children, block.id)),
        // Reads the circuit on the device and settles this block against
        // it (see deviceSync.js) — run once a board is known to be running.
        reconcile: () => reconcileWithDevice(nodigraph, block),
        loadFromDevice: () => loadFromDevice(nodigraph, block),
        setPin: (gpio, state, opts) => serialConsole.setPin(block.id, gpio, state, opts),
        // The board's own shell (see serialConsole.shell): `nodes`, `wifi
        // status`, `can <text>` — anything `help` lists.
        shell: (line, opts) => serialConsole.shell(block.id, line, opts),
        // Every line on the link, with `unsolicited` for the ones no command
        // asked for (a CAN reply after `can <text>`, a [USB] line); returns
        // the unsubscribe function.
        subscribeLines: (listener) => serialConsole.subscribeConsoleLines(block.id, listener),
        // The far end of each of this board's socket pins, by name — the
        // block its exterior wire reaches ('cnc'), or 'browser' when the
        // wire ends at nothing.
        socketPeers: () => {
          const level = devkitCircuit.findContainingLevel(nodigraph.project.rootBlock.children, block.id);
          return socketPortsOf(block).map(({ port, direction }) => {
            let peer = 'browser';
            for (const conn of level?.connections?.values?.() || []) {
              const otherId = conn.sourceBlockId === block.id && conn.sourcePortId === port.id ? conn.targetBlockId
                : conn.targetBlockId === block.id && conn.targetPortId === port.id ? conn.sourceBlockId : null;
              if (!otherId || otherId === block.id) continue;
              const other = level.blocks?.get?.(otherId);
              if (other) peer = other.name || peer;
            }
            return { portId: port.id, direction, peer };
          });
        },
        readPins: (opts) => serialConsole.readPins(block.id, opts),
        close: () => serialConsole.closeConsole(block.id),
      },
      // The machine panel (see cncPanel.js) on the board this block
      // belongs to — the board's own dialog, or a CNC block inside it —
      // driven through that board's shell, whatever its link.
      cnc: {
        mountPanel: (target, opts = {}) => {
          const link = cncLinkFor(block);
          if (!link) {
            target.textContent = 'Place this block inside a board to drive its CNC.';
            return () => {};
          }
          return mountCncPanel(target, { ...opts, ...link });
        },
        // The whole control (editor, files, machine) in place, or in a
        // modal of its own — closing the dialog this was asked from.
        mountControl: (target) => mountControlFor(block, target),
        openControl: () => openCncControl(block),
        // Whether the board answers as having grbl (`cnc ?` reports).
        probe: async () => {
          const link = cncLinkFor(block);
          if (!link || !link.isLinked()) return false;
          const reply = await link.shell('cnc ?', { quiet: true, timeoutMs: 1500 }).catch(() => null);
          return readStatusReply(reply).kind === 'report';
        },
      },
    };

    const outputs = getLastResult().outputsByBlock.get(block.id) || {};
    try {
      // eslint-disable-next-line no-new-func
      new Function('container', 'block', 'props', 'outputs', 'helpers', String(executableSource))(body, block, propsObject(block), outputs, helpers);
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

  const api = { drawBlock, openDialog, openCncControl };
  installed = api;
  return api;
}
