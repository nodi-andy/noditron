// Sets window.nodigraphExtraTabs *before* nodigraph's own main.js runs
// (see index.html's script order, and nodigraph's own comment on why this
// has to be a pre-set global rather than a parameter it could accept) —
// this is what actually puts the "Logic" tab beside nodigraph's native
// Inspector tab.
//
// DISABLED FOR NOW: the whole custom-behavior surface (Function / Render /
// HTML / Dialog — see logicTab.js) is hidden, so no extra tab is
// registered at all and the Inspector shows only nodigraph's own native
// one. Nothing about how those props *work* changed: every block still
// carries its `fn`/`render`/`html`/`dialog` props and runtime.js/
// canvasIndicators.js/htmlOverlay.js/dialogSystem.js still run them
// exactly as before — they just can't be edited from the Inspector while
// this is commented out. Restore by uncommenting the two lines below.
// import { renderLogicTab } from './logicTab.js';
//
// window.nodigraphExtraTabs = [{ label: 'Logic', render: renderLogicTab }];

// With the tab gone, those same four props would still have shown up in
// the Inspector's plain Properties list — a whole function body squeezed
// into a one-line text field, which is exactly the surface this is meant
// to be hiding. Same pre-set-global contract as the line above (see
// nodigraph's InspectorPanel `hiddenPropNames`). Remove this alongside
// uncommenting the tab if the Logic surface comes back — with the tab
// there, keeping these out of Properties is still the right call, since
// the tab is where they belong.
window.nodigraphHiddenProps = ['fn', 'render', 'html', 'dialog'];
