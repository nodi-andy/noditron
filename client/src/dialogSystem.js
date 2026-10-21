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
    const boardProp = (name) => board.props.find((p) => p.name === name);
    const keepOnBoard = (name, value) => {
      const prop = boardProp(name);
      if (prop && prop.value === value) return;
      if (prop) prop.value = value;
      else board.props.push({ id: `${board.id}:${name}`, name, kind: 'value', value });
      board.description = serializeBlockDescription(board);
      nodigraph.persist();
    };
    const shell = (line, shellOpts) => serialConsole.shell(board.id, line, shellOpts);
    // The reports this board's CNC pushes over the bus, through whichever
    // board bridges it (see serialConsole.subscribePushes): they name it by
    // its node name, or its id when the bridge knows no name.
    const subscribeReports = (listener) => serialConsole.subscribePushes(({ from, line }) => {
      const names = [boardProp('nodeId')?.value, boardProp('nodeName')?.value].filter(Boolean).map(String);
      if (names.includes(from)) listener(line);
    });
    return {
      board,
      shell,
      subscribeReports,
      isLinked: () => Boolean(serialFlash.getSession(board.id) || serialConsole.bridgeFor(board.id)),
      isBusy: () => serialFlash.isFlashing(board.id),
      program: String(boardProp('cncProgram')?.value || ''),
      saveProgram: (text) => keepOnBoard('cncProgram', text),
      settings: cncSettingsFor(board, shell, keepOnBoard),
    };
  }

  // The CNC control's Settings: what an operator sets, nothing grbl-deep.
  //   jogFeed   mm/min a held jog runs at; kept on the board block
  //   seek/feed homing's fast approach and slow touch-off, mm/min ($25/$24)
  //   pulloff   how far homing backs off the switch, mm ($27); grbl backs
  //             off up to five times that to clear it, and a fast seek
  //             runs further onto the switch before it stops
  //   homeToMin per axis: homes toward its min end (Homing/DirInvert, $23)
  // The homing speeds are also the circuit's (its CNC block's Homing group
  // sets them in grbl at every load), so they are written there too — in
  // the drawn CNC block and saved to the board, or, with no CNC block
  // drawn, into the circuit the board holds. Direction is grbl's alone.
  function cncSettingsFor(board, shell, keepOnBoard) {
    const grblNumber = async (n) => {
      const reply = await shell(`cnc $${n}`, { timeoutMs: 4000 });
      const m = (reply.lines || []).map((l) => String(l).match(new RegExp(`^\\$${n}=(-?[\\d.]+)`))).find(Boolean);
      return m ? Number(m[1]) : null;
    };
    const grblSet = async (n, value) => {
      const reply = await shell(`cnc $${n}=${value}`, { timeoutMs: 4000 });
      if (!reply.ok) throw new Error(`$${n}: ${reply.error || 'no answer'}`);
    };
    const drawnHoming = () => {
      for (const child of board.children?.blocks?.values?.() || []) {
        if (kindOf(child) !== 'cnc') continue;
        for (const group of child.children?.blocks?.values?.() || []) {
          if (String(group.name).toLowerCase() === 'homing' && group.children) return group;
        }
      }
      return null;
    };
    async function saveHomingToCircuit(speeds) {
      const homing = drawnHoming();
      if (homing) {
        for (const leaf of homing.children.blocks.values()) {
          const key = String(leaf.name).toLowerCase();
          if (!(key in speeds)) continue;
          const prop = leaf.props.find((p) => p.name === 'value');
          if (prop) prop.value = speeds[key];
          leaf.description = serializeBlockDescription(leaf);
        }
        const level = devkitCircuit.findContainingLevel(nodigraph.project.rootBlock.children, board.id);
        const design = devkitCircuit.buildDevkitDesign(board, level);
        await serialConsole.sendDesign(board.id, design);
        devkitCircuit.markDevkitSent(board, design);
        nodigraph.persist();
        nodigraph.renderLoop.requestRender();
        return;
      }
      const design = await serialConsole.readDesign(board.id);
      const cnc = (design?.blocks || []).find((b) => b.type === 'cnc');
      if (!cnc) return;  // no CNC in the circuit: grbl's own values stand
      cnc.data = cnc.data || {};
      cnc.data.settings = { ...(cnc.data.settings || {}), ...Object.fromEntries(Object.entries(speeds).map(([k, v]) => [`homing/${k}`, v])) };
      await serialConsole.sendDesign(board.id, design);
    }
    return {
      async read(axes) {
        const [seek, feed, pulloff, mask, idleLock] = [await grblNumber(25), await grblNumber(24), await grblNumber(27), await grblNumber(23), await grblNumber(1)];
        const homeToMin = Object.fromEntries(axes.map((a, i) => [a, mask === null ? true : Boolean(mask & (1 << i))]));
        // $1: how long the motors stay powered after a move, ms; 255 = always.
        const idlePowered = idleLock === null ? true : idleLock >= 255;
        return { jogFeed: Number(board.props.find((p) => p.name === 'cncJogFeed')?.value) || 1000, seek, feed, pulloff, homeToMin, idlePowered };
      },
      async save({ jogFeed, seek, feed, pulloff, homeToMin, idlePowered }, axes) {
        if (jogFeed) keepOnBoard('cncJogFeed', Number(jogFeed));
        const mask = axes.reduce((m, a, i) => (homeToMin[a] ? m | (1 << i) : m), 0);
        await grblSet(1, idlePowered ? 255 : 250);
        await grblSet(23, mask);
        await grblSet(25, seek);
        await grblSet(24, feed);
        await grblSet(27, pulloff);
        await saveHomingToCircuit({ seek, feed, pulloff });
      },
      jogFeed: () => Number(board.props.find((p) => p.name === 'cncJogFeed')?.value) || 1000,
    };
  }

  function mountControlFor(block, target) {
    const link = cncLinkFor(block);
    if (!link) {
      target.textContent = 'Place this block inside a board to drive its CNC.';
      return () => {};
    }
    return mountCncControl(target, link);
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
