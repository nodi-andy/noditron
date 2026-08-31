// noditron's own bootstrap — the only piece of this app that isn't just
// "read nodigraph's public state." nodigraph's own main.js (loaded first,
// see index.html) runs its bootstrap() without this page ever awaiting it,
// so window.nodigraph (see that file's own comment) may not exist the
// instant this module starts; a short poll covers that gap without this
// file needing to know anything about nodigraph's internal timing.
import { mountPalette } from './palette.js';
import { mountLibrary } from './library.js';
import { startRuntime, kindOf } from './runtime.js';
import { installCanvasIndicators } from './canvasIndicators.js';
import { installHtmlOverlay } from './htmlOverlay.js';
import { installDialogSystem } from './dialogSystem.js';
import * as serialFlash from './serialFlash.js';
import * as serialConsole from './serialConsole.js';

// noditron's own "primitive" kinds — plain value/logic leaves with no
// business growing a sub-architecture of their own (unlike Timer, whose
// whole T_ON/T_OFF design *depends* on being a container). See
// window.nodigraphCanEnter below and palette.js's own addKindProp calls
// for where each one gets tagged.
const NO_SUB_ARCHITECTURE_KINDS = ['digital-io', 'and', 'data'];

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

  mountPalette(nodigraph, document.getElementById('noditron-palette'));
  mountLibrary(nodigraph, document.getElementById('noditron-palette'));

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

  window.nodigraphDrawBlock = (ctx, block) => {
    canvasIndicators.drawBlock(ctx, block);
    htmlOverlay.drawBlock(ctx, block);
    dialogSystem.drawBlock(ctx, block);
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
  window.nodigraphCanEnter = (block) => !NO_SUB_ARCHITECTURE_KINDS.includes(kindOf(block));

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
  function collectEsp32DevkitBlocks(level, out = []) {
    if (!level) return out;
    for (const block of level.blocks.values()) {
      if (kindOf(block) === 'esp32-devkit') out.push(block);
      if (block.children) collectEsp32DevkitBlocks(block.children, out);
    }
    return out;
  }
  window.nodigraphAfterSave = async () => {
    const devkits = collectEsp32DevkitBlocks(nodigraph.project.rootBlock.children);
    let changed = false;
    for (const esp of devkits) {
      // No live session for this block right now (never connected this
      // page load, or the connectionState prop is stale from before a
      // reload) -- nothing to push to, silently skip rather than error.
      if (!serialFlash.getSession(esp.id)) continue;
      if ((esp.props || []).find((p) => p.name === 'connectionState')?.value !== 'connected:running') continue;
      const children = esp.children ? Array.from(esp.children.blocks.values()) : [];
      const design = serialConsole.buildMinimalDesign(children);
      if (!design.blocks.length) continue;
      const snapshot = JSON.stringify(children.map((c) => ({ id: c.id, props: c.props })));
      const lastSentProp = esp.props.find((p) => p.name === 'lastSentSnapshot');
      if (snapshot === (lastSentProp?.value || '')) continue;
      try {
        await serialConsole.sendDesign(esp.id, design);
        if (lastSentProp) lastSentProp.value = snapshot;
        const bd = await import('/nodigraph/src/model/BlockDescription.js');
        esp.description = bd.serializeBlockDescription(esp);
        changed = true;
      } catch (err) {
        console.warn(`[noditron] Save-triggered device push failed for "${esp.name}":`, err.message);
      }
    }
    if (changed) nodigraph.persist();
  };

  // Still the "global timer" for block *values* — runtime.js's own
  // getLastResult() is what canvasIndicators.js/htmlOverlay.js read each
  // paint. Also where htmlOverlay's own container cleanup happens (see its
  // own doc on why that's fine to leave off the per-frame path).
  startRuntime(nodigraph, () => {
    const byId = new Map(nodigraph.project.listBlocks().map((b) => [b.id, b]));
    htmlOverlay.prune(byId);
    nodigraph.renderLoop.requestRender();
  });
}

boot();
