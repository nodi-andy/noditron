// noditron's own bootstrap — the only piece of this app that isn't just
// "read nodigraph's public state." nodigraph's own main.js (loaded first,
// see index.html) runs its bootstrap() without this page ever awaiting it,
// so window.nodigraph (see that file's own comment) may not exist the
// instant this module starts; a short poll covers that gap without this
// file needing to know anything about nodigraph's internal timing.
import { mountPalette } from './palette.js';
import { startRuntime, kindOf } from './runtime.js';
import { installCanvasIndicators } from './canvasIndicators.js';
import { installHtmlOverlay } from './htmlOverlay.js';
import { installDialogSystem } from './dialogSystem.js';

// noditron's own "primitive" kinds — plain value/logic leaves with no
// business growing a sub-architecture of their own (unlike Timer, whose
// whole T_ON/T_OFF design *depends* on being a container). See
// window.nodigraphCanEnter below and palette.js's own addKindProp calls
// for where each one gets tagged.
const NO_SUB_ARCHITECTURE_KINDS = ['bool', 'and', 'data'];

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
