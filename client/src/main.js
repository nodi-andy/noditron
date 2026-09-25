// noditron's own bootstrap — the only piece of this app that isn't just
// "read nodigraph's public state." nodigraph's own main.js (loaded first,
// see index.html) runs its bootstrap() without this page ever awaiting it,
// so window.nodigraph (see that file's own comment) may not exist the
// instant this module starts; a short poll covers that gap without this
// file needing to know anything about nodigraph's internal timing.
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { mountPalette, rehydrateKindLogic, migrateLegacyDataBlock } from './palette.js';
import { mountLibrary } from './library.js';
import { startRuntime, kindOf, getLastResult, getBoundaryOutput, getPortValue, setBoundaryInput, setBoundaryOutput, clearBoundaryOutput, setChildOutput, clearChildOutputs } from './runtime.js';
import { installCanvasIndicators } from './canvasIndicators.js';
import { installHtmlOverlay } from './htmlOverlay.js';
import { installDialogSystem } from './dialogSystem.js';
import * as serialFlash from './serialFlash.js';
import * as serialConsole from './serialConsole.js';
import * as livePins from './livePins.js';
import * as devkitCircuit from './devkitCircuit.js';
import { createDeviceSaver } from './deviceSave.js';
import { installSerialReconnect } from './serialReconnect.js';

// noditron's own "primitive" kinds — plain value/logic leaves with no
// business growing a sub-architecture of their own (unlike Timer, whose
// whole T_ON/T_OFF design *depends* on being a container). See
// window.nodigraphCanEnter below and palette.js's own addKindProp calls
// for where each one gets tagged.
const NO_SUB_ARCHITECTURE_KINDS = [
  'digital-io', 'and', 'or', 'gate', 'not', 'data', 'add',
  // conucon's Logic Module blocks (see palette.js) — every one is a leaf
  // the firmware runs directly; none has an inside.
  'boot', 'serial', 'serialin', 'can', 'i2cout', 'i2cin', 'pwmout', 'pwmin', 'slice', 'route', 'croute',
  // A CNC module is grbl behind a gcode input: nothing to build inside.
  'cnc-module',
];
const ESP32_TEMPLATE_PROP_NAMES = ['render', 'html', 'dialog', 'allowedChildKinds', 'usbOrientation', 'boardVariant', 'pinMap', 'onboardControls', 'firmwarePreset', 'canPins'];

function waitForNodigraph() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.nodigraph) resolve(window.nodigraph);
      else setTimeout(check, 20);
    };
    check();
  });
}

async function boot() {
  const nodigraph = await waitForNodigraph();

  const palette = mountPalette(nodigraph, document.getElementById('noditron-palette'));
  const library = mountLibrary(nodigraph, document.getElementById('noditron-palette'));

  // Three independent draw contributors, composed into the single
  // window.nodigraphDrawBlock hook nodigraph calls once per block per
  // frame (see SceneRenderer's own doc on it): canvas indicators (`render`
  // prop), positioned real DOM (`html` prop), and the settings-gear
  // fallback (`dialog` prop with no `html` of its own). Each module owns
  // its own click handling too (separate capture-phase listeners are fine
  // — each just hit-tests its own thing and only acts+stops on a match).
  const dialogSystem = installDialogSystem(nodigraph);
  const canvasIndicators = installCanvasIndicators(nodigraph);
  const htmlOverlay = installHtmlOverlay(nodigraph, dialogSystem.openDialog);

  window.nodigraphDrawBlock = (ctx, block, { contentAlpha = 1, transform = null } = {}) => {
    // `ctx` arrives already faded by the level this block sits in (see
    // nodigraph's drawSubPreview: a level opening inside its block fades
    // in, and everything drawn straight onto ctx fades with it). Real DOM
    // does not draw onto ctx, so it has to be handed that fade explicitly
    // or a Data block's value pops in at full strength while the level
    // around it is still a ghost.
    const levelAlpha = typeof ctx.globalAlpha === 'number' ? ctx.globalAlpha : 1;
    // The infinite canvas fades the block's face as its interior opens.
    // Custom board artwork must fade too, or it paints over the circuit.
    // Keep connection controls visible while the host still blocks entry.
    if (window.nodigraphCanEnter?.(block) === false) contentAlpha = 1;
    ctx.save();
    ctx.globalAlpha *= contentAlpha;
    if (contentAlpha > 0) {
      canvasIndicators.drawBlock(ctx, block);
      dialogSystem.drawBlock(ctx, block);
    }
    ctx.restore();
    htmlOverlay.drawBlock(ctx, block, { contentAlpha: contentAlpha * levelAlpha, transform });
  };

  // Every scene paint is bracketed so the overlay can tell which of its
  // containers nodigraph actually drew this frame and hide the rest (see
  // htmlOverlay's own beginFrame/endFrame). RenderLoop calls drawFn as a
  // plain property, so wrapping it here needs nothing from nodigraph.
  const drawScene = nodigraph.renderLoop.drawFn;
  nodigraph.renderLoop.drawFn = () => {
    htmlOverlay.beginFrame();
    try {
      drawScene();
    } finally {
      htmlOverlay.endFrame();
    }
  };

  // The cog button in nodigraph's own bottom-left selection FAB stack (see
  // SelectionFabs.js's getExtraFab and main.js's own comment on this exact
  // hook) — shown whenever the selected block has a non-empty `dialog`,
  // opening it the same way its own on-canvas gear would. This is the
  // *only* way in for a block like Data that has no on-canvas gear of its
  // own (see palette.js's own doc on why) — but it works for any block
  // with a dialog, DIN/Weather included, as a second route to the same
  // place their own embedded gear already opens.
  window.nodigraphSelectionFab = {
    title: 'Edit value',
    // No className given — nodigraph's own default (.fab-extra, amber)
    // already reads as visually distinct from its four built-in mini-FABs.
    icon: '<text x="12" y="17" text-anchor="middle" font-size="15" fill="currentColor">⚙</text>',
    isVisible: (block) => Boolean(String(block.props?.find((p) => p.name === 'dialog')?.value || '').trim()),
    onClick: (block) => dialogSystem.openDialog(block),
  };

  // Vetoes drilling into a Bool/Data/AND-gate — see nodigraph's own
  // main.js (enterBlock) and InspectorPanel.js (canEnterBlock) for the two
  // places this is actually enforced; both read this same hook, so
  // there's exactly one thing to set here to cover double-click *and* the
  // Inspector's own "Enter block" button. Read fresh on every attempt
  // (nodigraph's own doc on it), so setting it here — after nodigraph's
  // own bootstrap has already run — still works.
  window.nodigraphCanEnter = (block) => {
    const kind = kindOf(block);
    if (kind === 'esp32-devkit') {
      const state = (block.props || []).find((p) => p.name === 'connectionState')?.value || 'disconnected';
      if (state !== 'connected:running') return false;
    }
    return !NO_SUB_ARCHITECTURE_KINDS.includes(kind);
  };
  window.nodigraphOnEnterBlocked = (block) => {
    if (kindOf(block) === 'esp32-devkit') dialogSystem.openDialog(block);
  };

  // Fills a block's noditron-specific logic back in after it arrives
  // through nodigraph's own generic slim-YAML paste (see nodigraph's
  // main.js — window.nodigraphRehydrateBlock, a new host hook alongside
  // nodigraphDrawBlock/nodigraphCanEnter above), which restores plain-data
  // props faithfully but has no idea `fn`/`render`/`html`/`dialog`/
  // `noditronKind` mean anything — see palette.js's own rehydrateKindLogic
  // for why this lives there instead of a second copy of every kind's
  // logic. Deliberately not window.nodigraphAfterSave/nodigraphCanEnter's
  // sibling for nodigraph's OTHER paste path (Ctrl+C/Ctrl+V's own JSON
  // clipboard format, model/clipboard.js) -- that one already carries
  // every prop verbatim and never had this gap.
  window.nodigraphRehydrateBlock = rehydrateKindLogic;

  async function refreshEsp32DevkitTemplates() {
    // Each board refreshes from the module it was installed from — its
    // noditronModuleSource names it (see library.js) — not from
    // esp32-devkit for all: every ESP32 variant shares the esp32-devkit
    // kind, so an S3 board used to be handed the classic board's props, and
    // its pins too. A board placed before modules recorded their source is
    // a classic DevKit. Each module is fetched once per load.
    const templates = new Map();
    async function templateFor(moduleName) {
      if (!templates.has(moduleName)) {
        let template = null;
        try {
          const response = await fetch(`/api/modules/${encodeURIComponent(moduleName)}`);
          if (response.ok) template = (await response.json())?.block?.blocks?.[0] || null;
        } catch {
          template = null;
        }
        templates.set(moduleName, template);
      }
      return templates.get(moduleName);
    }
    function moduleNameOf(block) {
      const source = (block.props || []).find((p) => p.name === 'noditronModuleSource')?.value;
      try {
        return JSON.parse(source || '{}').name || 'esp32-devkit';
      } catch {
        return 'esp32-devkit';
      }
    }
    let changed = false;
    // The whole block tree, not project.listBlocks() — that only returns
    // the level currently being viewed, so an ESP32 DevKit went un-refreshed
    // whenever it wasn't on screen, including the very common case of
    // standing *inside* it (then listBlocks() returns its children and the
    // board itself is never even considered). That left already-placed
    // boards running whatever dialog/render code they were pasted with,
    // which is what made a stale dialog outlive edits to the module.
    for (const { block, level } of devkitCircuit.collectBoardBlocks(nodigraph.project.rootBlock.children)) {
      const templateBlock = await templateFor(moduleNameOf(block));
      if (!templateBlock) continue;
      if (devkitCircuit.migrateWaveshareBoard(block, templateBlock, level)) changed = true;
      for (const name of ESP32_TEMPLATE_PROP_NAMES) {
        const src = (templateBlock.props || []).find((p) => p.name === name);
        if (!src) continue;
        const existing = (block.props || []).find((p) => p.name === name);
        if (existing && existing.value !== src.value) {
          existing.value = src.value;
          changed = true;
        } else if (!existing) {
          block.props.push({ ...src, id: `${src.id}_${block.id}` });
          changed = true;
        }
      }
      // Pins the module has gained since this board was placed (GPIO0 on
      // the BOOT button, say): added by name, never moved or removed, so a
      // wire already on a board pin is never disturbed. A pin on the top or
      // bottom edge keeps its distance from the centre, where the board
      // drawing puts USB, buttons and LED whatever the board's width.
      for (const tplLogical of templateBlock.logicalPorts || []) {
        if ((block.logicalPorts || []).some((lp) => lp.name === tplLogical.name)) continue;
        const tplPin = (templateBlock.ports || []).find((pin) => pin.logicalId === tplLogical.id);
        if (!tplPin) continue;
        const logicalId = `${tplLogical.id}_${block.id}`;
        let offset = tplPin.offset;
        if (tplPin.side === 'top' || tplPin.side === 'bottom') {
          offset = block.geometry.width / 2 + (tplPin.offset - templateBlock.geometry.width / 2);
        }
        block.logicalPorts = [...(block.logicalPorts || []), { ...tplLogical, id: logicalId }];
        block.ports = [...(block.ports || []), { ...tplPin, id: `${tplPin.id}_${block.id}`, logicalId, offset }];
        changed = true;
      }
      if (changed) {
        const bd = await import('/nodigraph/src/model/BlockDescription.js');
        block.description = bd.serializeBlockDescription(block);
      }
    }
    if (changed) {
      nodigraph.persist();
      nodigraph.renderLoop.requestRender();
    }
  }
  refreshEsp32DevkitTemplates();

  // Data blocks saved before `in` became a trigger (see palette.js's
  // migrateLegacyDataBlock) are brought up to the current one here, once at
  // load. The whole block tree, not project.listBlocks(), for the same
  // reason refreshEsp32DevkitTemplates walks it: listBlocks() only returns
  // the level currently on screen, and a block nested inside a container
  // would otherwise stay on the old behavior until someone happened to
  // navigate into it.
  function migrateDataBlocks(level) {
    if (!level) return false;
    let changed = false;
    for (const block of level.blocks.values()) {
      if (migrateLegacyDataBlock(block)) changed = true;
      if (block.children && migrateDataBlocks(block.children)) changed = true;
    }
    return changed;
  }
  if (migrateDataBlocks(nodigraph.project.rootBlock.children)) {
    nodigraph.persist();
    nodigraph.renderLoop.requestRender();
  }

  // `connectionState` is a persisted prop, but the serial session it
  // describes is not — a Web Serial port only lives as long as the page
  // that opened it. So a board left "connected:running" when the project
  // was last saved comes back claiming to be running with nothing actually
  // on the other end: the on-canvas card shows its green "Logic Module
  // running" dot, the dialog logs that same stale value, and both the
  // dialog's "Save changes to device" section and the Save-triggered push
  // (window.nodigraphAfterSave) stay hidden/skipped, since each of those
  // *correctly* also requires a live serialFlash session. The visible
  // result is a board that looks connected, says "Circuit changed -- not
  // sent", and offers no way to send it. Nothing can hold a session this
  // early in a page's life, so any leftover "connected:*" here is stale by
  // definition: reset it, and the card honestly reads "Not connected"
  // until Connect actually runs again.
  function resetStaleConnectionStates() {
    let changed = false;
    for (const { block } of devkitCircuit.collectBoardBlocks(nodigraph.project.rootBlock.children)) {
      const prop = (block.props || []).find((p) => p.name === 'connectionState');
      if (!prop || !String(prop.value || '').startsWith('connect')) continue;
      prop.value = 'disconnected';
      block.description = serializeBlockDescription(block);
      changed = true;
    }
    if (changed) {
      nodigraph.persist();
      nodigraph.renderLoop.requestRender();
    }
  }
  resetStaleConnectionStates();

  // With every board honestly "Not connected", offer the ones that were
  // connected last time their port back — a card at the bottom of the
  // page, connecting on request (see serialReconnect.js for why not
  // silently).
  installSerialReconnect(nodigraph, { openDialog: dialogSystem.openDialog });

  // Colors a wire by whatever boolean value it's actually carrying right
  // now — green while true/high, dim gray while false/low — read straight
  // from the same per-tick evaluation everything else here already relies
  // on (see runtime.js's own startRuntime doc). getLastResult().outputValue
  // covers same-level wires directly; getBoundaryOutput (also runtime.js's
  // own) covers one whose source lives on a different level, the same
  // fallback inputsFor() itself already uses internally. Deliberately
  // leaves entry.connection.color completely untouched (see
  // SceneRenderer.js's own doc on why this hook exists instead of just
  // writing that prop directly) — a non-boolean value (a string, a number,
  // still-undefined because nothing's fired through this wire yet) falls
  // through to null, which SceneRenderer.js then falls back from to the
  // wire's own stored color or the plain default blue, exactly as if this
  // hook didn't exist for that wire at all.
  window.nodigraphConnectionColor = (connection) => {
    // getPortValue, not getLastResult().outputValue: this hook is asked
    // about every wire nodigraph draws, including the ones inside a
    // container shown open on the canvas while the current level is still
    // the one outside it. Those live on a different level, so the
    // current-level-only result had nothing for them and every such wire
    // drew as if nothing were flowing (see runtime.js's getPortValue).
    const direct = getPortValue(connection.sourceBlockId, connection.sourcePortId);
    const value = direct !== undefined ? direct : getBoundaryOutput(connection.sourceBlockId, connection.sourcePortId);
    // Nothing on this wire at all — no opinion, so it draws in its own
    // stored colour or the plain default.
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? '#3ecf5d' : '#4a5568';
    // Any other value present IS a signal on the wire, and reads as one:
    // a Data block firing its string onto the belt is no less a signal
    // than a button going high, and used to draw identically to a wire
    // with nothing on it at all, which made firing invisible.
    return '#3ecf5d';
  };

  window.nodigraphPortColor = (block, port) => {
    if (kindOf(block) !== 'esp32-devkit' || !devkitCircuit.isDevkitRunning(block) || !serialFlash.getSession(block.id)) return null;
    const name = logicalName(block, port.id);
    const pin = pinMapFor(block).find(p => p.label === name);
    if (!pin || pin.gpio === null || pin.reserved) return null;
    const live = livePins.getCachedPins(block.id)?.find(p => Number(p.gpio) === Number(pin.gpio));
    return live ? (live.state ? '#3ecf5d' : '#64748b') : null;
  };
  window.nodigraphPortValue = (block, port) => {
    if (kindOf(block) !== 'esp32-devkit' || !devkitCircuit.isDevkitRunning(block) || !serialFlash.getSession(block.id)) return undefined;
    const name = logicalName(block, port.id);
    const pin = pinMapFor(block).find(p => p.label === name);
    if (!pin?.inputOnly || pin.gpio === null || pin.gpio === undefined) return undefined;
    const live = livePins.getCachedPins(block.id)?.find(p => Number(p.gpio) === Number(pin.gpio));
    return live ? Boolean(live.state) : undefined;
  };

  // Pushes any connected+running ESP32 DevKit's pending circuit changes to
  // its device whenever the user does an explicit project Save (see
  // nodigraph's own main.js — window.nodigraphAfterSave, a new host hook
  // alongside window.nodigraphDrawBlock etc.) — previously the *only* way
  // to sync a board was opening its own dialog and clicking "Save changes
  // to device" by hand. Walks the whole block tree, not just the current
  // level, since the device you're editing may not be the one you're
  // looking at right now. Deliberately not wired to persist()/autosave —
  // that fires after every single edit (a drag, a prop tweak), which would
  // spam the serial link; an explicit Save is a deliberate, occasional
  // action, the same one the dialog's own button already represents.
  function logicalName(block, portId) {
    const pin = (block.ports || []).find((p) => p.id === portId);
    const logical = pin && (block.logicalPorts || []).find((lp) => lp.id === pin.logicalId);
    return logical?.name || null;
  }

  function pinMapFor(block) {
    const prop = (block.props || []).find((p) => p.name === 'pinMap');
    try {
      const map = JSON.parse(prop?.value || '[]');
      return Array.isArray(map) ? map : [];
    } catch {
      return [];
    }
  }

  function buildExternalDevkitDesign(esp, level) {
    const gpioByPortName = new Map(
      pinMapFor(esp)
        .filter((pin) => pin.gpio !== null && pin.gpio !== undefined)
        .map((pin) => [pin.label, Number(pin.gpio)]),
    );
    const syntheticPins = new Map();

    function syntheticPinBlock(gpio, direction) {
      const key = `${direction}:${gpio}`;
      if (syntheticPins.has(key)) return syntheticPins.get(key);
      const block = {
        id: `${esp.id}:${key}`,
        name: `GPIO${gpio}`,
        logicalPorts: [{ id: `${esp.id}:${key}:io`, name: 'value', direction: direction === 'output' ? 'in' : 'out' }],
        ports: [{ id: `${esp.id}:${key}:port`, logicalId: `${esp.id}:${key}:io`, side: direction === 'output' ? 'left' : 'right', offset: 20, manualOffset: true }],
        props: [
          { id: `${esp.id}:${key}:pin`, name: 'pin', kind: 'value', value: gpio },
          { id: `${esp.id}:${key}:dir`, name: 'direction', kind: 'value', value: direction },
          { id: `${esp.id}:${key}:value`, name: 'value', kind: 'range', min: 0, max: 1, value: 0 },
          { id: `${esp.id}:${key}:kind`, name: 'noditronKind', kind: 'value', value: 'digital-io' },
        ],
      };
      syntheticPins.set(key, block);
      return block;
    }

    function mapEndpoint(blockId, portId, isTarget) {
      if (blockId !== esp.id) return { blockId, portId };
      const portName = logicalName(esp, portId);
      const gpio = gpioByPortName.get(portName);
      if (gpio === undefined) return null;
      const pin = syntheticPinBlock(gpio, isTarget ? 'output' : 'input');
      return { blockId: pin.id, portId: pin.ports[0].id };
    }

    const connections = [];
    for (const conn of Array.from(level.connections.values())) {
      const source = mapEndpoint(conn.sourceBlockId, conn.sourcePortId, false);
      const target = mapEndpoint(conn.targetBlockId, conn.targetPortId, true);
      if (!source || !target) continue;
      connections.push({
        ...conn,
        sourceBlockId: source.blockId,
        sourcePortId: source.portId,
        targetBlockId: target.blockId,
        targetPortId: target.portId,
      });
    }

    const siblingBlocks = Array.from(level.blocks.values()).filter((block) => block.id !== esp.id && kindOf(block) !== 'esp32-devkit');
    return serialConsole.buildMinimalDesign([...siblingBlocks, ...syntheticPins.values()], connections);
  }

  function buildDevkitDesign(esp, level) {
    const children = esp.children ? Array.from(esp.children.blocks.values()) : [];
    const childConnections = esp.children ? Array.from(esp.children.connections.values()) : [];
    const internal = serialConsole.buildMinimalDesign(children, childConnections);
    const external = buildExternalDevkitDesign(esp, level);
    return external.blocks.length ? external : internal;
  }

  function devkitSnapshot(esp, level) {
    const siblings = Array.from(level.blocks.values())
      .filter((block) => block.id !== esp.id)
      .map((block) => ({ id: block.id, props: block.props, ports: block.ports, logicalPorts: block.logicalPorts }));
    const levelConnections = Array.from(level.connections.values()).map((cn) => ({
      s: cn.sourceBlockId, sp: cn.sourcePortId, t: cn.targetBlockId, tp: cn.targetPortId,
    }));
    const children = esp.children ? Array.from(esp.children.blocks.values()).map((block) => ({ id: block.id, props: block.props })) : [];
    const childConnections = esp.children ? Array.from(esp.children.connections.values()).map((cn) => ({
      s: cn.sourceBlockId, sp: cn.sourcePortId, t: cn.targetBlockId, tp: cn.targetPortId,
    })) : [];
    return JSON.stringify({ siblings, levelConnections, children, childConnections });
  }

  function collectEsp32DevkitBlocks(level, out = []) {
    if (!level) return out;
    for (const block of level.blocks.values()) {
      if (kindOf(block) === 'esp32-devkit') out.push({ block, level });
      if (block.children) collectEsp32DevkitBlocks(block.children, out);
    }
    return out;
  }
  window.nodigraphBeforeSave = createDeviceSaver({
    project: nodigraph.project,
    getSession: serialFlash.getSession,
    sendDesign: serialConsole.sendDesign,
    persist: nodigraph.persist,
    openDialog: dialogSystem.openDialog,
  });
  window.nodigraphHasUnsavedChanges = () => devkitCircuit.collectEsp32DevkitBlocks(nodigraph.project.rootBlock.children)
    .some(({ block, level }) => devkitCircuit.isDevkitDirty(block, level));

  // Keeps every Digital I/O (Bool) child's own props.value in sync with
  // its connected board's live GPIO state, regardless of which level is
  // currently on screen — runtime.js's own beforeLevel hook (see its own
  // doc), called once per container right before that container's own
  // children get evaluated, so this tick's `fn` runs (and anything reading
  // this value through a boundary port two levels up, say) see the fresh
  // reading, not a stale one from whenever this container was last looked
  // at directly. Previously this lived inside DIGITAL_IO_HTML (palette.js)
  // itself, which only runs while a block is actually being *drawn* — the
  // exact level-gating that made a board's own Input pin readable from
  // its own dialog but frozen the moment you looked anywhere else instead
  // (reported: "created an output to parent but can not read the value").
  // Only ever *reads* hardware state here, never writes it back to a real
  // pin — an Output's own live push still only ever happens from an actual
  // user click (see DIGITAL_IO_HTML's own click handler) or conucon's own
  // belt-routed circuit running on the board itself, never from a tick.
  function syncLiveDigitalIO(container, blocks) {
    if (kindOf(container) !== 'esp32-devkit') return;
    // The board's USB pin (pinMap role usb-serial) carries, to the level
    // above, what the board's circuit actually sent over USB — only while
    // the board is connected and running; otherwise the simulation's own
    // value for it stands.
    const usbPortNames = new Set(pinMapFor(container).filter((p) => p.role === 'usb-serial').map((p) => p.label));
    const usbPorts = (container.ports || []).filter((port) => usbPortNames.has(logicalName(container, port.id)));
    const live =
      (container.props || []).find((p) => p.name === 'connectionState')?.value === 'connected:running'
      && Boolean(serialFlash.getSession(container.id)); // never connected this page load, or stale prop from before a reload
    for (const port of usbPorts) {
      // A value the board actually SENT wins; anything else leaves the
      // simulation's own value standing. The test used to be merely "is a
      // board connected", and an override of `undefined` does not mean
      // "no opinion" — runtime.js deletes the port's computed value for
      // it. So plugging a board in made this pin go dark: the circuit in
      // the browser was still producing a value, and connecting hardware
      // that had not yet said anything actively suppressed it. Which is
      // exactly backwards, since a board says nothing until its own
      // uploaded design has a USB serial chain to say it with.
      const sent = live ? serialConsole.getUsbValue(container.id)?.value : undefined;
      if (sent !== undefined) setBoundaryOutput(container.id, port.id, sent);
      else clearBoundaryOutput(container.id, port.id);
    }
    // ESP32 child circuits are firmware-owned even while disconnected. The
    // browser must never run a competing simulation that can rewrite Data
    // values or make a Timer appear to drive hardware locally.
    // Refilled below from this tick's readings; a board that is no longer
    // live keeps nothing stale on its children.
    clearChildOutputs(container.id);
    if (!live) return false;
    const inputs = pinMapFor(container).filter(p => !p.reserved && !p.outputOnly && p.gpio !== null && p.gpio !== undefined && p.gpio < 1000).map(p => Number(p.gpio));
    livePins.ensurePolling(container.id, inputs);
    const cached = livePins.getCachedPins(container.id);
    if (!cached) return;
    // The board's own pins carry their live state into the level, so a
    // block wired straight to one — a pin-less Bool on GPIO0's BOOT button,
    // say — sees the hardware without needing a pin of its own. Only pins
    // the uploaded circuit declares are reported, and only those are set.
    const gpioByName = new Map(pinMapFor(container).filter((p) => p.gpio !== null && p.gpio !== undefined).map((p) => [p.label, Number(p.gpio)]));
    for (const port of container.ports || []) {
      const gpio = gpioByName.get(logicalName(container, port.id));
      const live = gpio === undefined ? null : cached.find((p) => Number(p.gpio) === gpio);
      if (live) setBoundaryInput(container.id, port.id, Boolean(live.state));
    }
    // The browser does not run a board's children (see the return below),
    // so nothing inside would ever show a value. What the board reports
    // for an output pin, or sends over USB, IS what the child wired to
    // that pin is putting out: the Timer driving DO1 blinks with the
    // board's own DO1, and its wire colours with it (see runtime.js's
    // setChildOutput).
    const usbSent = serialConsole.getUsbValue(container.id)?.value;
    for (const conn of container.children?.connections?.values?.() || []) {
      if (conn.targetBlockId !== container.id || conn.sourceBlockId === container.id) continue;
      const name = logicalName(container, conn.targetPortId);
      let value;
      if (usbPortNames.has(name)) {
        value = usbSent;
      } else {
        const gpio = gpioByName.get(name);
        const livePin = gpio === undefined ? null : cached.find((p) => Number(p.gpio) === gpio);
        if (livePin) value = Boolean(livePin.state);
      }
      if (value !== undefined) setChildOutput(container.id, conn.sourceBlockId, conn.sourcePortId, value);
    }
    let changed = false;
    for (const child of blocks) {
      if (kindOf(child) !== 'digital-io') continue;
      const pin = (child.props || []).find((p) => p.name === 'pin')?.value;
      if (pin === null || pin === undefined || pin === '') continue;
      const live = cached.find((p) => Number(p.gpio) === Number(pin));
      if (!live) continue;
      const valueProp = child.props.find((p) => p.name === 'value');
      const wantValue = live.state ? 1 : 0;
      if (valueProp && Number(valueProp.value) !== wantValue) {
        valueProp.value = wantValue;
        changed = true;
      }
    }
    // Live readings are telemetry, not user edits.
    // A connected board is authoritative: do not also execute its child
    // graph in the browser and overwrite the values the firmware owns.
    return false;
  }

  // Still the "global timer" for block *values* — runtime.js's own
  // getLastResult() is what canvasIndicators.js/htmlOverlay.js read each
  // paint. Also where htmlOverlay's own container cleanup happens (see its
  // own doc on why that's fine to leave off the per-frame path), and where
  // the palette/library re-filter themselves against whichever container's
  // now current (see palette.js/library.js's own refresh() and
  // containerRestrictions.js) — nodigraph has no "you just entered a
  // different block" event of its own to hook, so this just compares
  // project.path against what it was last tick, which is already ticking
  // here at a rate no navigation could outrun.
  // The palette and library offer what fits where a new block would land
  // (see containerRestrictions.addTarget), which moves with the selection
  // as well as with navigation — so both are part of the key.
  const addTargetKey = () => JSON.stringify([nodigraph.project.path, nodigraph.addTarget?.()?.id ?? null]);
  let lastPathJson = addTargetKey();
  // A CNC module's `gcode` input is the machine's feed: whatever value
  // sits on it is sent as `g <line>` through the board's shell each time
  // it changes (a Data block's text, a Match output) — grbl answers ok or
  // error: on the shell, and the dialog's shell box shows both.
  const lastGcodeSent = new Map(); // blockId -> last text sent
  function forwardGcodeToCncModules() {
    for (const { block, level } of devkitCircuit.collectBoardBlocks(nodigraph.project.rootBlock.children)) {
      if (kindOf(block) !== 'cnc-module') continue;
      if (!serialFlash.getSession(block.id) || !devkitCircuit.isDevkitRunning(block)) {
        lastGcodeSent.delete(block.id);
        continue;
      }
      const port = (block.ports || []).find((p) => logicalName(block, p.id) === 'gcode');
      const conn = port && [...(level?.connections?.values?.() || [])].find((c) => c.targetBlockId === block.id && c.targetPortId === port.id);
      if (!conn) continue;
      const direct = getPortValue(conn.sourceBlockId, conn.sourcePortId);
      const value = direct !== undefined ? direct : getBoundaryOutput(conn.sourceBlockId, conn.sourcePortId);
      if (value === undefined || value === null || value === false) continue;
      const text = String(value).trim();
      if (!text || lastGcodeSent.get(block.id) === text) continue;
      lastGcodeSent.set(block.id, text);
      serialConsole.shell(block.id, `g ${text}`).catch((err) => console.warn(`[noditron] ${block.name}: gcode not sent:`, err.message));
    }
  }

  startRuntime(
    nodigraph,
    () => {
      forwardGcodeToCncModules();
      // The whole tree, not listBlocks(): that is only the level being
      // edited, so standing inside a board pruned the board's own overlay
      // every tick and the next frame built it again — its pill flickered
      // ten times a second for as long as you stayed inside.
      const byId = new Map();
      (function collect(level) {
        for (const block of level?.blocks?.values?.() || []) {
          byId.set(block.id, block);
          if (block.children) collect(block.children);
        }
      })(nodigraph.project.rootBlock.children);
      htmlOverlay.prune(byId);
      nodigraph.refreshSaved?.();
      nodigraph.renderLoop.requestRender();

      const pathJson = addTargetKey();
      if (pathJson !== lastPathJson) {
        lastPathJson = pathJson;
        palette.refresh();
        library.refresh();
      }
    },
    100,
    syncLiveDigitalIO,
  );
}

boot();
