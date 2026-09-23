// The "3 simple nodes to pick" palette. Every block it creates is built
// entirely through nodigraph's own public model API (createBlock, addPort,
// project.addBlock, ...) — exactly what a person clicking nodigraph's own
// "+ Add block" / "+ Add port" buttons would produce, just done in code and
// pre-wired with the right ports and a `noditronKind` prop (see runtime.js)
// up front. Nothing here is special-cased inside nodigraph itself.
import { createBlock, generateId } from '/nodigraph/src/model/Block.js';
import { addPort, logicalPortOf, serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { createConnection } from '/nodigraph/src/model/Connection.js';
import { KIND_PROP } from './runtime.js';
import { getAllowedChildKinds, prepareAdd } from './containerRestrictions.js';

// `hidden` ships a port that's real and wireable but not painted on the
// canvas until someone reveals it from the Inspector's own port list (see
// nodigraph's BlockDescription.isPortHidden) — for a secondary input that
// would otherwise clutter every instance of a block most people only ever
// use one way. Data's `write` is the first of these.
function addNamedPort(block, direction, name, { hidden = false } = {}) {
  const pin = addPort(block, { direction, hidden });
  logicalPortOf(block, pin).name = name;
  return pin;
}

function addKindProp(block, kind) {
  block.props.push({ id: generateId('prp'), name: KIND_PROP, kind: 'value', value: kind });
}

// `fn`/`render` are the same two props the Inspector's "Logic" tab edits
// (see logicTab.js/runtime.js/canvasIndicators.js) — seeded here with the
// source that reproduces this block's built-in behavior, so creating one
// from the palette and then opening its Logic tab shows real, working,
// editable code rather than an empty box.
function addLogicProps(block, fnSource, renderSource) {
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: fnSource });
  block.props.push({ id: generateId('prp'), name: 'render', kind: 'value', value: renderSource });
}

// nodigraph draws a block's name centred on it by default — which is
// exactly where a block that renders its own face wants to put its value
// (see DATA_HTML and readoutHtml, both of which sit their readout at the
// bottom of the card). On a block tall enough the two coexist; on a short
// one — 200x40, say — they land in the same few pixels and the value
// reads as floating on top of the name. Moving the name to the top keeps
// both legible at any height, and only ever applies to a block that
// actually draws a face of its own.
function titleAtTop(block) {
  if (!(block.props || []).some((p) => p.name === 'html' && String(p.value || '').trim())) return;
  block.style = { ...(block.style || {}), titlePos: 'top' };
}

function finish(nodigraph, block) {
  titleAtTop(block);
  block.description = serializeBlockDescription(block);
  nodigraph.project.addBlock(block);
  nodigraph.selection.select(block.id);
  nodigraph.renderLoop.requestRender();
  nodigraph.persist();
  return block;
}

// Screen-center of the canvas, in world coordinates — new blocks land
// wherever you're actually looking, not at some fixed world origin that
// might be off-screen after panning around.
function viewCenter(nodigraph) {
  const canvas = document.getElementById('scene-canvas');
  const rect = canvas.getBoundingClientRect();
  return nodigraph.camera.screenToWorld(rect.width / 2, rect.height / 2);
}

// Each successive add lands a little further down-right of the last, so
// clicking a palette button repeatedly doesn't stack every block exactly
// on top of the one before it.
let placementCount = 0;
function nextPosition(nodigraph) {
  const center = viewCenter(nodigraph);
  const offset = (placementCount += 1) * 24;
  return { x: Math.round((center.x - 80 + offset) / 10) * 10, y: Math.round((center.y - 40 + offset) / 10) * 10 };
}

// Digital I/O replaces what used to be two separate primitives — Bool (a
// plain manual toggle, no pin) and Digital Input (a fixed, input-only GPIO
// reading) — with one block that covers both plus the output direction
// neither had: pick a pin (or "Simulated" for the old Bool behavior, no
// pin at all) and a direction, and it's whichever of the three this canvas
// needs. This is also the block a future esp32-devkit sub-circuit sync
// reads pin/direction off of (see modules/esp32-devkit's own dialog) —
// one shape for "a single digital signal," not three.
//
// Direction is a real port swap (out for input, in for output), not just a
// label — see DIGITAL_IO_DIALOG's own change handler, which does the same
// remove-then-add-port dance the Inspector's own port list does, including
// dropping any wire that pointed at whichever port direction switching
// away from.
const DIGITAL_IO_HTML = `
container.style.display = 'flex';
container.style.flexDirection = 'column';
container.style.justifyContent = 'space-between';
container.style.alignItems = 'center';
container.style.boxSizing = 'border-box';
container.style.padding = '8px';
container.style.fontFamily = 'Inter, sans-serif';

let badge = container.querySelector('.dio-badge');
if (!badge) {
  badge = document.createElement('div');
  badge.className = 'dio-badge';
  badge.style.cssText = 'align-self:flex-start;font-size:10px;font-weight:700;letter-spacing:.03em;color:var(--text-muted);';

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'dio-gear';
  gear.textContent = String.fromCharCode(9881);
  gear.title = 'Configure';
  gear.style.cssText = 'position:absolute;top:4px;right:4px;width:20px;height:20px;padding:0;border-radius:5px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:11px;line-height:1;cursor:pointer;';
  gear.addEventListener('click', helpers.openDialog);

  // A real <button>, not a <div> -- only input/select/button/textarea/a get
  // pointer-events back from noditron-html-block's own blanket "let clicks
  // fall through to the canvas underneath" rule (see styles.css), so a plain
  // div here would silently never receive a click at all, real user or not.
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'dio-dot';
  dot.style.cssText = 'width:18px;height:18px;padding:0;border-radius:50%;border:2px solid var(--border);background:none;box-sizing:border-box;';
  dot.addEventListener('click', async () => {
    const dir = (block.props.find((p) => p.name === 'direction') || {}).value || 'input';
    const pinNow = (block.props.find((p) => p.name === 'pin') || {}).value;
    const simulatedNow = pinNow === null || pinNow === undefined || pinNow === '';
    // Output is the settable direction (drives a real GPIO or stands in as
    // a manual constant when unwired) -- input is a read-only reflection of
    // whatever feeds it (a wire, or a connected board's own live reading).
    // Simulated (no real pin) skips this restriction entirely -- there's no
    // real hardware direction to respect, so it's always click-settable; a
    // wire into "in", if present, still wins each tick regardless (see this
    // block's own fn).
    if (!simulatedNow && dir !== 'output') return;
    const current = block.props.find((p) => p.name === 'value');
    const next = Number(current && current.value) >= 1 ? 0 : 1;
    helpers.setProp('value', next);

    // Best-effort live hardware push -- only when this block sits directly
    // inside a connected+running ESP32 DevKit with a real pin set. A silent
    // no-op otherwise (pure simulation, not connected, or genuinely no pin
    // picked). Convenience alongside the parent's own "Live Pins" panel
    // (see modules/esp32-devkit's dialog), not a replacement for it.
    const pinProp = block.props.find((p) => p.name === 'pin');
    const pin = pinProp ? pinProp.value : null;
    if (pin === null || pin === undefined || pin === '') return;
    const parent = window.nodigraph?.project?.getContainerBlock?.();
    if (!parent || (parent.props || []).find((p) => p.name === 'noditronKind')?.value !== 'esp32-devkit') return;
    if ((parent.props || []).find((p) => p.name === 'connectionState')?.value !== 'connected:running') return;
    try {
      const serialConsole = await import('/src/serialConsole.js');
      await serialConsole.setPin(parent.id, Number(pin), next);
    } catch (err) {
      console.warn('[Bool] Live hardware set failed:', err.message);
    }
  });

  container.append(badge, gear, dot);
}

const pinProp = block.props.find((p) => p.name === 'pin');
const pin = pinProp ? pinProp.value : null;
const simulated = pin === null || pin === undefined || pin === '';
const direction = ((block.props.find((p) => p.name === 'direction') || {}).value) === 'output' ? 'output' : 'input';
// Simulated is bidirectional (see this block's own fn) -- no direction
// suffix, since none applies.
badge.textContent = simulated ? 'SIM' : 'GPIO' + pin + ' · ' + direction.toUpperCase();

const dot = container.querySelector('.dio-dot');

// Pure observation, not control: a connected, running ESP32 DevKit
// actually runs din->dout forwarding itself now (see buildMinimalDesign
// in serialConsole.js, which compiles a wire between two Bool blocks into
// real conucon belts) -- the board no longer needs this browser tab open
// to keep an Output pin following a wired Input; it runs the loop on its
// own, at its own loop() speed, observer or not.
//
// props.value itself is kept fresh from the board's own live reading
// regardless of whether this specific block is even being drawn right
// now -- see main.js's own syncLiveDigitalIO, a runtime.js beforeLevel
// hook that runs once per tick for every level in the whole tree, not
// just whatever's on screen.
//
// This block's own fn always returns both "value" and "out" carrying the
// same computed boolean (see createDigitalIOBlock), regardless of which
// port(s) actually exist right now -- so this can just read outputs.out
// unconditionally instead of picking between outputs.value/inputs.value/
// a locally-tracked "current" value by hand.
const on = Boolean(outputs.out);
dot.style.background = on ? '#3ecf5d' : 'transparent';
dot.style.borderColor = on ? '#3ecf5d' : 'var(--border)';
dot.style.cursor = (simulated || direction === 'output') ? 'pointer' : 'default';
`.trim();

const DIGITAL_IO_DIALOG = `
container.style.fontFamily = 'Inter, sans-serif';

const heading = document.createElement('h3');
heading.textContent = String(block.name || 'BOOL').toUpperCase();
heading.style.cssText = 'margin:0 0 14px;color:var(--success,#3ecf5d);font-size:15px;letter-spacing:.03em;';
container.appendChild(heading);

function section(labelText) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:16px;';
  const label = document.createElement('div');
  label.textContent = labelText;
  label.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px;';
  wrap.appendChild(label);
  container.appendChild(wrap);
  return wrap;
}

const fieldStyle = 'width:100%;padding:6px 8px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:13px;box-sizing:border-box;';

const simulated = props.pin === null || props.pin === undefined || props.pin === '';

// A real hardware direction only means something once there's a real pin
// to respect -- Simulated is a bidirectional test point (both "in" and
// "out" ports at once, see createDigitalIOBlock), so this section simply
// doesn't exist while Simulated rather than showing a control with no
// effect on anything.
let dirSelect = null;
if (!simulated) {
  const dirSection = section('DIRECTION');
  dirSelect = document.createElement('select');
  dirSelect.style.cssText = fieldStyle;
  [['input', 'Input (reads a signal)'], ['output', 'Output (drives a signal)']].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    dirSelect.appendChild(opt);
  });
  dirSelect.value = props.direction === 'output' ? 'output' : 'input';
  dirSection.appendChild(dirSelect);
}

const pinSection = section('PIN');
const pinSelect = document.createElement('select');
pinSelect.style.cssText = fieldStyle;
const simOpt = document.createElement('option');
simOpt.value = '';
simOpt.textContent = 'Simulated (no pin)';
pinSelect.appendChild(simOpt);
for (let i = 0; i <= 39; i += 1) {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = 'GPIO ' + i;
  pinSelect.appendChild(opt);
}
pinSelect.value = props.pin === null || props.pin === undefined ? '' : String(props.pin);
pinSection.appendChild(pinSelect);

const pinHint = document.createElement('p');
pinHint.textContent = simulated
  ? 'No pin -- a plain test point. It has both an input and an output port for its value at once, and stays click-settable on canvas regardless of wiring: a wire into it, if present, wins over the last click each tick (unwire it and the last click applies again).'
  : 'The value below always simulates locally too, connected or not. If this block sits directly inside a connected, running ESP32 DevKit and has a real pin set, an Output also drives the real GPIO live.';
pinHint.style.cssText = 'margin:6px 0 0;font-size:11px;color:var(--text-muted);';
pinSection.appendChild(pinHint);

const valueSection = section('VALUE');
const valueRow = document.createElement('div');
valueRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = '0';
slider.max = '1';
slider.step = '1';
slider.value = String(Number(props.value || 0));
slider.style.flex = '1';
// Settable whenever there's no real hardware direction to respect
// (Simulated) or the real direction is Output (drives a real GPIO, or
// stands in as a manual constant when unwired) -- a real Input pin is the
// only case this stays read-only. See this block's own html prop
// (DIGITAL_IO_HTML) for the matching on-canvas dot, which follows the
// same rule.
slider.disabled = !simulated && dirSelect.value === 'input';
const readout = document.createElement('span');
readout.style.cssText = 'font-size:12px;color:var(--text-muted);min-width:34px;';
function describe(v) { return Number(v) >= 1 ? 'HIGH' : 'LOW'; }
readout.textContent = describe(props.value);
slider.addEventListener('input', async () => {
  const next = Number(slider.value);
  helpers.setProp('value', next);
  readout.textContent = describe(slider.value);
  if (simulated) return;
  if (dirSelect.value !== 'output') return;
  if (props.pin === null || props.pin === undefined || props.pin === '') return;
  const parent = window.nodigraph?.project?.getContainerBlock?.();
  if (!parent || (parent.props || []).find((p) => p.name === 'noditronKind')?.value !== 'esp32-devkit') return;
  if ((parent.props || []).find((p) => p.name === 'connectionState')?.value !== 'connected:running') return;
  try {
    const serialConsole = await import('/src/serialConsole.js');
    await serialConsole.setPin(parent.id, Number(props.pin), next);
  } catch (err) {
    console.warn('[Bool] Live hardware set failed:', err.message);
  }
});
valueRow.append(slider, readout);
valueSection.appendChild(valueRow);
if (!simulated && dirSelect.value === 'input') {
  const inHint = document.createElement('p');
  inHint.textContent = 'Read-only -- an input reflects whatever is wired into it, or the live reading from a connected board. Switch to Output to set it by hand.';
  inHint.style.cssText = 'margin:6px 0 0;font-size:11px;color:var(--text-muted);';
  valueSection.appendChild(inHint);
}

// Both a Simulated<->real-pin swap and a direction change on an already-
// real pin go through the same remove-then-add-port dance the Inspector's
// own port list uses, including dropping any wire that pointed at
// whichever port went away. Picking a *different* real GPIO number is a
// no-op here (same desired shape as what's already there), so the current
// ports are simply left alone rather than torn down and rebuilt for
// nothing.
async function syncPorts(pinValue, dirValue) {
  const nowSimulated = pinValue === '';
  const desired = nowSimulated ? [['in', 'in'], ['out', 'out']] : [[dirValue === 'output' ? 'in' : 'out', 'value']];
  const current = (block.logicalPorts || [])
    .map((lp) => {
      const pin = (block.ports || []).find((p) => p.logicalId === lp.id);
      return (pin ? lp.direction : '?') + ':' + lp.name;
    })
    .sort()
    .join(',');
  const desiredKey = desired.map(([d, n]) => d + ':' + n).sort().join(',');
  if (current === desiredKey) return false;
  const bd = await import('/nodigraph/src/model/BlockDescription.js');
  for (const lp of [...(block.logicalPorts || [])]) {
    const removedPinIds = bd.removeLogicalPort(block, lp.id);
    for (const pinId of removedPinIds) helpers.project.removeConnectionsForPort(pinId);
  }
  for (const [direction, name] of desired) {
    bd.addPort(block, { direction });
    const newLogical = block.logicalPorts[block.logicalPorts.length - 1];
    if (newLogical) newLogical.name = name;
  }
  block.description = bd.serializeBlockDescription(block);
  return true;
}

pinSelect.addEventListener('change', async () => {
  helpers.setProp('pin', pinSelect.value === '' ? null : Number(pinSelect.value));
  const dirNow = (block.props.find((p) => p.name === 'direction') || {}).value || 'input';
  const portsChanged = await syncPorts(pinSelect.value, dirNow);
  helpers.refresh();
  if (portsChanged) helpers.close();
});

if (dirSelect) {
  dirSelect.addEventListener('change', async () => {
    helpers.setProp('direction', dirSelect.value);
    const portsChanged = await syncPorts(pinSelect.value, dirSelect.value);
    helpers.refresh();
    if (portsChanged) helpers.close();
  });
}
`.trim();

export function createDigitalIOBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Bool' });
  // No real pin yet (Simulated) -- starts with both ports at once, `in`
  // and `out`, rather than the single direction-swapped `value` port a
  // real GPIO gets (see DIGITAL_IO_DIALOG's own syncPorts): with no actual
  // hardware direction to respect, there's no reason to pick one. A wire
  // into `in`, if present, wins over the manual value each tick (see this
  // block's own fn) -- same in-overrides-constant rule Data already uses.
  addNamedPort(block, 'in', 'in');
  addNamedPort(block, 'out', 'out');
  block.props.push({ id: generateId('prp'), name: 'pin', kind: 'value', value: null });
  block.props.push({ id: generateId('prp'), name: 'direction', kind: 'value', value: 'input' });
  block.props.push({ id: generateId('prp'), name: 'value', kind: 'range', min: 0, max: 1, value: 0 });
  addKindProp(block, 'digital-io');
  addLogicProps(
    block,
    `const simulated = props.pin === null || props.pin === undefined || props.pin === ''; const v = simulated ? (inputs.in !== undefined ? Boolean(inputs.in) : Number(props.value) >= 1) : Number(props.value) >= 1; return { value: v, out: v };`,
    '// No canvas indicator dot here -- see this block\'s html prop for its on-canvas card instead.',
  );
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: DIGITAL_IO_HTML });
  block.props.push({ id: generateId('prp'), name: 'dialog', kind: 'value', value: DIGITAL_IO_DIALOG });
  return finish(nodigraph, block);
}

export function createAndBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'AND' });
  addNamedPort(block, 'in', 'a');
  addNamedPort(block, 'in', 'b');
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'and');
  addLogicProps(
    block,
    'return { out: Boolean(inputs.a) && Boolean(inputs.b) };',
    '// No indicator by default -- uncomment for one:\n// helpers.dot(Boolean(outputs.out));',
  );
  return finish(nodigraph, block);
}

export function createOrBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'OR' });
  addNamedPort(block, 'in', 'a');
  addNamedPort(block, 'in', 'b');
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'or');
  addLogicProps(
    block,
    'return { out: Boolean(inputs.a) || Boolean(inputs.b) };',
    '// No indicator by default -- uncomment for one:\n// helpers.dot(Boolean(outputs.out));',
  );
  return finish(nodigraph, block);
}

// Sums every input that currently carries a value. Deliberately not a
// fixed two-input adder: `inputs` is keyed by this block's own input port
// names and holds `undefined` for any port with nothing wired to it (see
// runtime.js's inputsFor), so walking it means "all connected inputs",
// whatever they happen to be called and however many there are. Add a port
// in the Inspector and it counts toward the sum with nothing here to
// change; unwire one and it drops out again.
//
// Booleans count as 1/0, which is what makes a Bool or a Digital I/O pin a
// usable input; text that isn't a number counts as 0 rather than turning
// the whole sum into NaN and taking every other input down with it.
//
// `fired` is the same one-tick pulse the Data block draws (see DATA_FN) —
// not a port, just something for this block's own html. Any input actually
// changing is what counts as this block being triggered; on the firmware
// side that's a real signal arriving, here it's the edge.
const ADD_FN = `
let sum = 0;
let fired = false;
for (const [name, value] of Object.entries(inputs)) {
  if (value === undefined) continue;
  if (helpers.changed(name, value)) fired = true;
  sum += Number(value) || 0;
}
return { out: sum, fired };
`.trim();

const ADD_HTML = `
container.style.display = 'flex';
container.style.alignItems = 'center';
container.style.justifyContent = 'center';
container.style.boxSizing = 'border-box';
container.style.padding = '6px';
container.style.fontFamily = 'Inter, sans-serif';

let val = container.querySelector('.add-sum');
if (!val) {
  val = document.createElement('div');
  val.className = 'add-sum';
  val.style.cssText = 'font-size:18px;font-weight:700;color:var(--text-primary,#fff);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  container.appendChild(val);
}
let lamp = container.querySelector('.add-fired');
if (!lamp) {
  lamp = document.createElement('div');
  lamp.className = 'add-fired';
  lamp.style.cssText = 'position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;border:1px solid var(--border,#8888);box-sizing:border-box;';
  container.appendChild(lamp);
}
const sum = outputs.out;
val.textContent = sum === undefined ? '0' : String(sum);

if (outputs.fired) lamp.dataset.firedAt = String(Date.now());
const lit = Date.now() - Number(lamp.dataset.firedAt || 0) < 180;
lamp.style.transition = lit ? 'none' : 'background .3s ease-out, box-shadow .3s ease-out';
lamp.style.background = lit ? 'var(--success, #3ecf5d)' : 'transparent';
lamp.style.boxShadow = lit ? '0 0 6px var(--success, #3ecf5d)' : 'none';
`.trim();

// Two inputs shown and a third hidden (see addNamedPort): adding two
// things is the ordinary case, and a third pin on every instance of it
// would be clutter — reveal `in3` from the Inspector's port list when a
// sum needs it, or add a fourth port of your own, which ADD_FN picks up
// without being told. 120 tall so the left edge has three real slots to
// put them in (see nodigraph's grid.getPortSlotOffsets — one per 40 units).
export function createAddBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Add' });
  block.geometry.width = 160;
  block.geometry.height = 120;
  addNamedPort(block, 'in', 'in1');
  addNamedPort(block, 'in', 'in2');
  addNamedPort(block, 'in', 'in3', { hidden: true });
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'add');
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: ADD_FN });
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: ADD_HTML });
  return finish(nodigraph, block);
}

// The "transistor" primitive: `sig` passes straight through to `out`
// while `ctrl` is high, and is blocked (out = false) while `ctrl` is low —
// same truth table as AND (see createAndBlock just above), but named and
// ported for the *gating* mental model rather than the boolean-logic one:
// a signal path with a control pin, not "two equal inputs". This is the
// building block a hand-built state machine gates its "only the active
// state reacts to a button press" logic through, without needing a
// dedicated State primitive.
export function createGateBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Gate' });
  addNamedPort(block, 'in', 'sig');
  addNamedPort(block, 'in', 'ctrl');
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'gate');
  addLogicProps(
    block,
    'return { out: Boolean(inputs.ctrl) && Boolean(inputs.sig) };',
    "helpers.dot(Boolean(outputs.out));",
  );
  return finish(nodigraph, block);
}

// Straight inversion -- `out` is always the opposite of `in`, no control
// pin (unlike Gate just above). The other half of the pair Gate needs for
// an "only on falling edge"/"forward unless active" kind of wiring: run a
// signal through a NOT first to invert it, then into a Gate's own `ctrl`.
export function createNotBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'NOT' });
  addNamedPort(block, 'in', 'in');
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'not');
  addLogicProps(block, 'return { out: !Boolean(inputs.in) };', 'helpers.dot(Boolean(outputs.out));');
  return finish(nodigraph, block);
}

// A state in a hand-built state machine — a real container (enterable,
// double-click in and its actual circuit is right there: seven ordinary
// Gate/NOT children, wired to each other and to this block's own `set`/
// `transIn`/`transOut`/`on` ports exactly the way a person would wire them
// by hand from the palette. Nothing about this circuit is special-cased —
// it's real enough that a from-scratch copy, built with nothing but the
// palette and nodigraph's own port/wire tools, works identically, and can
// be packaged and shared the same way any hand-built block can (see this
// project's own README, "Authoring one": select it, "Add from library…" →
// "Export selected as a module"). That's only possible because a
// container's boundary *input* now has a real path to an internal child
// (see runtime.js's own boundaryInputCache doc) — before that fix this had
// to be a single hand-written `fn` instead (see git history), which
// worked but hid the actual mechanism behind code nobody could see by
// entering the block.
//
// The circuit is a cross-coupled NAND latch (NAND = Gate + NOT, see
// Gate's own doc) — Gate1/Q and Gate2/Q-bar cross-feeding each other's
// `ctrl` — plus one more Gate+NOT pair (GateTrig/NotTrig) gating `transIn`
// by the latch's own current `on` state before it's allowed to reset
// anything: `set` (active-high) turns the latch on; `transIn` (also
// active-high), but *only* while already on, turns it back off — "only
// the active state reacts, and turns itself off on the way out," the
// self-clearing ring behavior a hand-wired chain of these needs, no
// separate reset signal required. `on` is `Q` itself, crossing straight
// out to this block's own boundary port the ordinary wired way (Q's own
// on-canvas dot shows the same thing once you enter the block).
//
// `transOut`, alone, is *not* wired the same way — GateTrig.out (the
// moment `transIn` actually gets through) fires and self-clears within
// the very same tick that resets Q, since Q feeding GateTrig's own `ctrl`
// is exactly what makes it self-clearing in the first place: by the
// relaxation's last, recorded pass this same tick, GateTrig has already
// un-fired right along with Q, so nothing outside this container could
// ever see that pulse over an ordinary wire — this isn't a bug in the
// latch, it's what "the pulse and the thing that consumes it live in the
// same feedback loop" necessarily means for a same-tick relaxation. The
// one line of `fn` below is what actually produces `transOut`: it watches
// this container's own already-settled `on` (via helpers.ownOutput — see
// runtime.js's own doc on it) and turns *that* value's high-to-low edge
// into a proper one-tick pulse with helpers.changed(), the same primitive
// every other edge-triggered signal in this file already relies on.
// Everything that actually decides *whether and when* to transition is
// still the visible Gate/NOT circuit above; this only relays its result
// across a tick boundary a same-tick wire can't cross.
//
// `transIn` gets the same edge treatment, the other direction — GateTrig
// only *gates* transIn by Q, it doesn't itself notice a held-high level
// from one already-passed transition versus a genuinely new one, so a
// signal source that stays high for more than a tick (an ordinary Bool
// left at 1, not released the instant it's clicked) would otherwise walk
// this state's own successor straight into resetting itself again the
// very next tick, cascading through however much of a hand-wired chain
// stays high that long. Turning transIn into a one-tick pulse here, the
// same way transOut becomes one, is what makes "one press, one step"
// hold regardless of how long the source actually stays high — see
// runtime.js's own captureBoundaryInputs doc for how returning a key
// matching an *input* port's name reshapes what the circuit inside
// actually receives on that port, transparently to the wiring itself.
const STATE_FN = `
const onNow = Boolean(helpers.ownOutput('on'));
const transOut = helpers.changed('on', onNow) && !onNow;
const transIn = helpers.changed('transIn', Boolean(inputs.transIn)) && Boolean(inputs.transIn);
return { transOut, transIn };
`.trim();
function wireInternal(block, source, sourcePort, target, targetPort) {
  const port = (b, name) => {
    const lp = (b.logicalPorts || []).find((l) => l.name === name);
    return (b.ports || []).find((p) => p.logicalId === lp.id).id;
  };
  const src = source === 'self' ? block : source;
  const tgt = target === 'self' ? block : target;
  const conn = createConnection({
    sourceBlockId: src.id,
    sourcePortId: port(src, sourcePort),
    targetBlockId: tgt.id,
    targetPortId: port(tgt, targetPort),
  });
  block.children.connections.set(conn.id, conn);
}

export function createStateBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'State' });
  addNamedPort(block, 'in', 'set');
  addNamedPort(block, 'in', 'transIn');
  addNamedPort(block, 'out', 'transOut');
  addNamedPort(block, 'out', 'on');
  addKindProp(block, 'state');
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: STATE_FN });

  block.hasChildren = true;
  block.boundaryGeometry = { x: 0, y: 0, width: 560, height: 420 };

  const stub = stubNodigraph();
  const notSet = createNotBlock(stub);
  const gate1 = createGateBlock(stub);
  const notQ = createNotBlock(stub);
  const gate2 = createGateBlock(stub);
  const notQbar = createNotBlock(stub);
  const gateTrig = createGateBlock(stub);
  const notTrig = createNotBlock(stub);

  notSet.name = 'NotSet'; Object.assign(notSet.geometry, { x: 40, y: 20 });
  gate1.name = 'Gate1'; Object.assign(gate1.geometry, { x: 220, y: 20 });
  notQ.name = 'Q'; Object.assign(notQ.geometry, { x: 400, y: 20 });
  gate2.name = 'Gate2'; Object.assign(gate2.geometry, { x: 220, y: 180 });
  notQbar.name = 'Q-bar'; Object.assign(notQbar.geometry, { x: 400, y: 180 });
  gateTrig.name = 'GateTrig'; Object.assign(gateTrig.geometry, { x: 40, y: 320 });
  notTrig.name = 'NotTrig'; Object.assign(notTrig.geometry, { x: 220, y: 320 });

  const children = [notSet, gate1, notQ, gate2, notQbar, gateTrig, notTrig];
  block.children = { blocks: new Map(children.map((c) => [c.id, c])), connections: new Map() };

  wireInternal(block, 'self', 'set', notSet, 'in');
  wireInternal(block, notSet, 'out', gate1, 'sig');
  wireInternal(block, notQbar, 'out', gate1, 'ctrl');
  wireInternal(block, gate1, 'out', notQ, 'in');
  wireInternal(block, notQ, 'out', gate2, 'ctrl');
  wireInternal(block, 'self', 'transIn', gateTrig, 'sig');
  wireInternal(block, notQ, 'out', gateTrig, 'ctrl');
  wireInternal(block, gateTrig, 'out', notTrig, 'in');
  wireInternal(block, notTrig, 'out', gate2, 'sig');
  wireInternal(block, gate2, 'out', notQbar, 'in');
  wireInternal(block, notQ, 'out', 'self', 'on');

  return finish(nodigraph, block);
}

export function createLedBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'LED' });
  addNamedPort(block, 'in', 'in');
  addKindProp(block, 'led');
  addLogicProps(block, 'return {};', 'helpers.dot(Boolean(inputs.in));');
  return finish(nodigraph, block);
}

// Like Digital I/O's simulated mode but holds any value, not just 0/1 — a
// plain constant "primitive". Its value is edited through the cog button
// in the bottom-left selection FAB stack (select the block — see
// window.nodigraphSelectionFab below), which opens this same `dialog` any
// block can have (see dialogSystem.js); there's no on-canvas gear of its
// own the way DIN/Weather draw one inside their own html, since a Data
// block's whole card is just its value.
//
// A standalone one (from the palette) also gets an *input* port, `in` —
// a plain trigger, matching what conucon's own `data` block does on the
// firmware side (see its circuitRecv: a signal arriving at a data block
// fires that block's stored value onto the belt, and the incoming value
// itself is discarded). So `in` never shows up on `out`: what leaves this
// block is always its own data, overwriting whatever poked it. Here, where
// every block's fn is simply re-run ~10x/second rather than woken by an
// event, `out` carries that data continuously and the trigger's only
// visible effect is the card's own flash — but the wiring means the same
// thing, and exports to an event-driven target (see serialConsole.js)
// unchanged.
//
// A second input, `write`, is the way to change the stored value from the
// diagram instead of by hand: whatever arrives there is latched into the
// block's own `value` prop, exactly as if it had been typed into the
// dialog. It ships *hidden* (see addNamedPort) — the trigger-plus-constant
// shape above is what a Data block is for nearly every use, and a second
// permanently-visible input on all of them would be clutter; reveal it per
// block from the Inspector's port list when it's actually wanted.
//
// One living inside a container as a named child (see createTimerBlock's
// T_ON/T_OFF) skips every port entirely — nothing there ever wires it,
// only reads its value by name (see runtime.js's helpers.childValue), so a
// port would just be dead weight.
const DATA_HTML = `
container.style.display = 'flex';
container.style.alignItems = 'flex-end';
container.style.justifyContent = 'center';
container.style.boxSizing = 'border-box';
container.style.padding = '6px';
container.style.fontFamily = 'Inter, sans-serif';

let val = container.querySelector('.data-value');
if (!val) {
  val = document.createElement('div');
  val.className = 'data-value';
  val.style.cssText = 'font-size:16px;font-weight:700;color:var(--success,#3ecf5d);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  container.appendChild(val);
}
// Show the live pass-through value when `in` carries one. This does not
// change the stored fallback; only `write` does that.
const stored = (block.props.find((p) => p.name === 'value') || {}).value;
const shown = inputs.in !== undefined ? inputs.in : stored;
val.textContent = typeof shown === 'object' && shown !== null ? JSON.stringify(shown) : String(shown);
`.trim();

// `in` is a live pass-through and never changes what this block holds.
// `write` is the one input that changes the stored value; __persist writes
// it onto the prop for real, the same as typing it into the dialog.
// `write` sets what this block holds, and is compared against the value
// the block ALREADY holds rather than against helpers.changed. That
// distinction is the whole thing: `changed` reports an *edge*, and is
// false both on the first tick a value is seen and on every tick a steady
// value stays put — so a constant arriving on a freshly wired write port
// (a Data block inside an ESP32 sending the same string out over USB, say)
// was seen once, recorded, and then ignored forever. Comparing against
// props.value instead means "the wire says this block should hold X, and
// it doesn't" — which is true until the write actually lands, however long
// the value has been sitting there, and self-evidently stops being true
// once it has. Serialized on both sides so an object compares by content.
// With no value on `in`, `out` carries the stored fallback.
const DATA_FN = `
const incoming = inputs.write;
if (incoming !== undefined && JSON.stringify(incoming) !== JSON.stringify(props.value)) {
  return { out: incoming, __persist: { value: incoming } };
}
return { out: inputs.in !== undefined ? inputs.in : props.value };
`.trim();

const DATA_DIALOG = `
container.style.fontFamily = 'Inter, sans-serif';

const heading = document.createElement('h3');
heading.textContent = String(block.name || 'DATA').toUpperCase();
heading.style.cssText = 'margin:0 0 14px;color:var(--success,#3ecf5d);font-size:15px;letter-spacing:.03em;';
container.appendChild(heading);

const label = document.createElement('div');
label.textContent = 'VALUE';
label.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px;';
container.appendChild(label);

const input = document.createElement('input');
input.type = 'text';
input.value = String(props.value);
input.style.cssText = 'width:100%;padding:6px 8px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:13px;box-sizing:border-box;';
input.addEventListener('change', () => {
  const raw = input.value;
  const num = Number(raw);
  helpers.setProp('value', raw.trim() !== '' && !Number.isNaN(num) ? num : raw);
});
container.appendChild(input);

const hint = document.createElement('p');
hint.textContent = "The data this block holds — numbers work as-is, anything else is kept as text. A signal on in passes through to out without changing this stored value. Wire the hidden write port (reveal it in the Inspector's port list) to change the stored value from the diagram.";
hint.style.cssText = 'margin:8px 0 0;font-size:11px;color:var(--text-muted);';
container.appendChild(hint);
`.trim();

function createDataBlock({ name = 'Data', value = 0, x = 0, y = 0, width = 160, height = 90, withPort = true } = {}) {
  const block = createBlock({ x, y, name });
  block.geometry.width = width;
  block.geometry.height = height;
  // No separate `changed` port here, unlike Bool — `out` already carries
  // the current value every tick, so a value edit already "fires" on `out`
  // by itself; a second port announcing the same fact separately would
  // just be redundant for a block this plain. A container's own named
  // child (withPort: false, see createTimerBlock) skips the ports
  // entirely, same as before — it's read directly by name, never wired.
  if (withPort) {
    addNamedPort(block, 'in', 'in');
    addNamedPort(block, 'in', 'write', { hidden: true });
    addNamedPort(block, 'out', 'out');
  }
  // Marks this as one of noditron's "primitive" kinds (see runtime.js's
  // kindOf and main.js's window.nodigraphCanEnter) — primitives are meant
  // to stay leaves, never grow a sub-architecture of their own.
  addKindProp(block, 'data');
  block.props.push({ id: generateId('prp'), name: 'value', kind: 'value', value });
  block.props.push({
    id: generateId('prp'),
    name: 'fn',
    kind: 'value',
    value: withPort ? DATA_FN : 'return { out: props.value };',
  });
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: DATA_HTML });
  block.props.push({ id: generateId('prp'), name: 'dialog', kind: 'value', value: DATA_DIALOG });
  block.description = serializeBlockDescription(block);
  return block;
}

export function createStandaloneDataBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  return finish(nodigraph, createDataBlock({ x, y, name: 'Data', value: 0 }));
}

// Blinks on a plain wall-clock cycle — `fn` reads Date.now() directly
// rather than keeping any state of its own, which fits runtime.js's own
// evaluation model (a block's fn is just re-run on every tick, nothing
// carried between calls) and means the blink stays in sync even across a
// page reload, since it isn't counting up from whenever the block loaded.
//
// T1/T2 are no longer its own props — they're two Data blocks (see above),
// T_ON and T_OFF, living in this block's own child-graph (double-click in
// to see them), read through helpers.childValue (see runtime.js), which
// just looks up that named child's own `value` prop directly — no port,
// no wire, since editing them is now the cog button in the selection FAB
// stack (see window.nodigraphSelectionFab), not something to wire up.
const TIMER_FN = `
const t1 = Number(helpers.childValue('T_ON')) || 500;
const t2 = Number(helpers.childValue('T_OFF')) || 500;
const phase = Date.now() % (t1 + t2);
return { out: phase < t1 };
`.trim();

export function createTimerBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Timer' });
  addNamedPort(block, 'out', 'out');
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: TIMER_FN });
  block.props.push({ id: generateId('prp'), name: 'render', kind: 'value', value: "helpers.dot(Boolean(outputs.out), '#3ecf5d');" });
  addKindProp(block, 'timer');

  block.hasChildren = true;
  block.boundaryGeometry = { x: 0, y: 0, width: 400, height: 220 };
  const tOn = createDataBlock({ name: 'T_ON', value: 500, x: 20, y: 65, withPort: false });
  const tOff = createDataBlock({ name: 'T_OFF', value: 500, x: 220, y: 65, withPort: false });
  block.children = {
    blocks: new Map([
      [tOn.id, tOn],
      [tOff.id, tOff],
    ]),
    connections: new Map(),
  };

  return finish(nodigraph, block);
}

// A few preset cities rather than free-form lat/lon typing — the dialog
// (see WEATHER_DIALOG below) just picks one, matching "location is
// selected in a custom dialog" directly rather than needing a geocoding
// step of its own.
const WEATHER_LOCATIONS = [
  { label: 'Berlin, DE', lat: 52.52, lon: 13.41 },
  { label: 'London, UK', lat: 51.51, lon: -0.13 },
  { label: 'New York, US', lat: 40.71, lon: -74.01 },
  { label: 'Tokyo, JP', lat: 35.68, lon: 139.69 },
  { label: 'Sydney, AU', lat: -33.87, lon: 151.21 },
  { label: 'Cape Town, ZA', lat: -33.92, lon: 18.42 },
  { label: 'Sao Paulo, BR', lat: -23.55, lon: -46.63 },
  { label: 'Mumbai, IN', lat: 19.08, lon: 72.88 },
];

// Open-Meteo: free, no API key, CORS-enabled for direct browser fetches —
// exactly what a plain `fn` (running in-page, no server of its own) needs.
// `trigger` only *starts* a fetch — a rising edge isn't tracked separately,
// a plain high level is enough, since helpers.fetchJson (see
// apiFetch.js/runtime.js) only actually fetches once per distinct URL
// regardless of how many ticks it's called on while high. Once that fetch
// has resolved, the output keeps reading from the very same cache on every
// later tick even after trigger drops back low — this block never
// actively "un-fetches" itself, so its last known value just sits there
// until either a new trigger re-reads the (still-cached, so instant)
// value, or the URL itself changes (a different location in the dialog),
// which starts the whole thing over for the new city. Only the *very*
// first evaluation of a URL that's never been triggered at all is held
// back — otherwise every block would fetch the instant it's created,
// which is exactly what "trigger" is supposed to gate.
const WEATHER_FN = `
const lat = Number(props.lat);
const lon = Number(props.lon);
const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=temperature_2m';
if (!inputs.trigger && helpers.fetchStatus(url) === 'idle') return { json: undefined };
return { json: helpers.fetchJson(url) };
`.trim();

const WEATHER_HTML = `
container.style.display = 'flex';
container.style.flexDirection = 'column';
container.style.justifyContent = 'space-between';
container.style.boxSizing = 'border-box';
container.style.padding = '8px 10px';
container.style.fontFamily = 'Inter, sans-serif';

let title = container.querySelector('.wx-title');
if (!title) {
  title = document.createElement('div');
  title.className = 'wx-title';
  title.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--success,#3ecf5d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:calc(100% - 26px);';

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'wx-gear';
  gear.textContent = String.fromCharCode(9881);
  gear.title = 'Configure';
  gear.style.cssText = 'position:absolute;top:4px;right:4px;width:20px;height:20px;padding:0;border-radius:5px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:11px;line-height:1;cursor:pointer;';
  gear.addEventListener('click', helpers.openDialog);

  const readout = document.createElement('div');
  readout.className = 'wx-readout';
  readout.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:var(--success,#3ecf5d);';

  container.append(title, gear, readout);
}

title.textContent = String(block.props.find((p) => p.name === 'location')?.value || 'Weather');

const temp = outputs.json && outputs.json.current ? outputs.json.current.temperature_2m : undefined;
const unit = (outputs.json && outputs.json.current_units && outputs.json.current_units.temperature_2m) || String.fromCharCode(176) + 'C';
container.querySelector('.wx-readout').textContent = temp === undefined ? (inputs.trigger ? String.fromCharCode(8230) : String.fromCharCode(8212)) : temp + unit;
`.trim();

const WEATHER_DIALOG = `
container.style.fontFamily = 'Inter, sans-serif';

const heading = document.createElement('h3');
heading.textContent = 'WEATHER';
heading.style.cssText = 'margin:0 0 14px;color:var(--success,#3ecf5d);font-size:15px;letter-spacing:.03em;';
container.appendChild(heading);

const label = document.createElement('div');
label.textContent = 'LOCATION';
label.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px;';
container.appendChild(label);

const select = document.createElement('select');
select.style.cssText = 'width:100%;padding:6px 8px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:13px;box-sizing:border-box;';
const locations = ${JSON.stringify(WEATHER_LOCATIONS)};
locations.forEach((loc, i) => {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = loc.label;
  select.appendChild(opt);
});
const currentIndex = Math.max(0, locations.findIndex((loc) => loc.label === props.location));
select.value = String(currentIndex);
select.addEventListener('change', () => {
  const loc = locations[Number(select.value)];
  helpers.setProp('location', loc.label);
  helpers.setProp('lat', loc.lat);
  helpers.setProp('lon', loc.lon);
});
container.appendChild(select);

const hint = document.createElement('p');
hint.textContent = 'Fetched from Open-Meteo (no key needed) whenever the trigger input is high.';
hint.style.cssText = 'margin:8px 0 0;font-size:11px;color:var(--text-muted);';
container.appendChild(hint);

const dataLabel = document.createElement('div');
dataLabel.textContent = 'LAST RESPONSE';
dataLabel.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin:16px 0 6px;';
container.appendChild(dataLabel);

const pre = document.createElement('pre');
pre.style.cssText = 'margin:0;padding:8px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text-primary);font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;box-sizing:border-box;';
pre.textContent = outputs && outputs.json ? JSON.stringify(outputs.json, null, 2) : '(not fetched yet -- trigger the block first)';
container.appendChild(pre);

const dataHint = document.createElement('p');
dataHint.textContent = "Use this to find the right key path for a JSON Field block's Selector, e.g. current.temperature_2m.";
dataHint.style.cssText = 'margin:6px 0 0;font-size:11px;color:var(--text-muted);';
container.appendChild(dataHint);
`.trim();

export function createWeatherBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Weather' });
  // No background on the html card means nodigraph's own centered name
  // would otherwise collide with this card's own title/readout — cleared
  // for the same reason DIN used to be, back when it was its own block
  // (see git history) rather than a Digital I/O mode.
  block.name = '';
  addNamedPort(block, 'in', 'trigger');
  addNamedPort(block, 'out', 'json');
  const first = WEATHER_LOCATIONS[0];
  block.props.push({ id: generateId('prp'), name: 'location', kind: 'value', value: first.label });
  block.props.push({ id: generateId('prp'), name: 'lat', kind: 'value', value: first.lat });
  block.props.push({ id: generateId('prp'), name: 'lon', kind: 'value', value: first.lon });
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: WEATHER_FN });
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: WEATHER_HTML });
  block.props.push({ id: generateId('prp'), name: 'dialog', kind: 'value', value: WEATHER_DIALOG });
  addKindProp(block, 'weather');
  return finish(nodigraph, block);
}

// Selects one field out of an incoming JSON value by name. The selector
// itself is a KEY child block in this block's own child-graph (double-
// click in to see it) — same pattern as Timer's T_ON/T_OFF: a portless
// Data primitive (see createDataBlock's withPort: false), read through
// helpers.childValue('KEY') rather than a plain prop, edited through the
// cog button in the selection FAB stack instead of nodigraph's native
// Properties panel. A plain dot-path string ('second', or
// 'current.temperature_2m' to reach into a nested object like Weather's
// own output). Accepts the incoming JSON either already parsed (an
// object, e.g. straight off Weather's `json` output) or as a raw JSON
// string, so it works standalone too.
const JSON_FIELD_FN = `
let obj = inputs.json;
if (typeof obj === 'string') {
  try { obj = JSON.parse(obj); } catch { return { value: undefined }; }
}
if (obj === undefined || obj === null) return { value: undefined };
const path = String(helpers.childValue('KEY') || '').split('.').filter(Boolean);
let cur = obj;
for (const seg of path) {
  if (cur === undefined || cur === null) { cur = undefined; break; }
  cur = cur[seg];
}
return { value: cur };
`.trim();

const JSON_FIELD_HTML = `
container.style.display = 'flex';
container.style.flexDirection = 'column';
container.style.alignItems = 'center';
container.style.justifyContent = 'center';
container.style.boxSizing = 'border-box';
container.style.padding = '6px';
container.style.fontFamily = 'Inter, sans-serif';
container.style.textAlign = 'center';

let label = container.querySelector('.jf-label');
if (!label) {
  label = document.createElement('div');
  label.className = 'jf-label';
  label.style.cssText = 'font-size:10px;color:var(--text-muted);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const val = document.createElement('div');
  val.className = 'jf-value';
  val.style.cssText = 'font-size:18px;font-weight:700;color:var(--success,#3ecf5d);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  container.append(label, val);
}

const keyChild = block.children ? [...block.children.blocks.values()].find((b) => b.name === 'KEY') : null;
const keyValue = keyChild ? keyChild.props.find((p) => p.name === 'value')?.value : '';
label.textContent = String(keyValue || '(key)');
const v = outputs.value;
container.querySelector('.jf-value').textContent = v === undefined ? String.fromCharCode(8212) : (typeof v === 'object' ? JSON.stringify(v) : String(v));
`.trim();

export function createJsonFieldBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'JSON Field' });
  // Same reasoning as Weather/Digital Input — no background on the html
  // card, so the redundant centered name would otherwise show through.
  block.name = '';
  addNamedPort(block, 'in', 'json');
  addNamedPort(block, 'out', 'value');
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: JSON_FIELD_FN });
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: JSON_FIELD_HTML });
  addKindProp(block, 'json-field');

  block.hasChildren = true;
  block.boundaryGeometry = { x: 0, y: 0, width: 240, height: 180 };
  const key = createDataBlock({ name: 'KEY', value: 'second', x: 40, y: 45, withPort: false });
  block.children = { blocks: new Map([[key.id, key]]), connections: new Map() };
  return finish(nodigraph, block);
}

// ---------------------------------------------------------------------------
// conucon's Logic Module, block for block
//
// Everything esp32_logic's firmware knows how to run (see its own
// main.cpp) except `belt` and `junc`, which are its grid-routing pieces —
// here a wire IS the belt, so they have nothing to be. Each block below
// keeps conucon's own type name as its noditronKind (`croute`, `pwmin`,
// `serialin`, ...) rather than a prettier one, because that name is the
// thing a future export has to emit, and a second vocabulary mapped onto
// the first is a translation table waiting to drift.
//
// What they do *here* varies by how much of the block is really hardware.
// `slice`, `route` and `croute` are pure data handling and run exactly as
// the firmware runs them, locally, with no board involved. The rest —
// serial, CAN, I2C, PWM — are hardware endpoints: the block carries the
// real settings the device needs and shows what last passed through it,
// but nothing is transmitted from the browser. That is the same split the
// Digital I/O block already lives with (its `pin` is metadata read by
// whatever eventually sends this circuit to a board, not a live readout).
// ---------------------------------------------------------------------------

// A plain settings panel built from a field list. Eleven blocks that are
// each "a handful of named settings" would otherwise mean eleven
// near-identical hand-written dialogs; this generates one as ordinary
// source, stored on the block like any other dialog (see dialogSystem.js)
// and editable per block afterwards.
function settingsDialog(title, fields) {
  return `
container.style.fontFamily = 'Inter, sans-serif';
const heading = document.createElement('h3');
heading.textContent = ${JSON.stringify(title)};
heading.style.cssText = 'margin:0 0 6px;color:var(--accent,#4f8cff);font-size:15px;letter-spacing:.03em;';
container.appendChild(heading);
for (const f of ${JSON.stringify(fields)}) {
  const label = document.createElement('div');
  label.textContent = f.label;
  label.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin:12px 0 4px;';
  container.appendChild(label);
  let input;
  if (f.options) {
    input = document.createElement('select');
    for (const opt of f.options) {
      const o = document.createElement('option');
      o.value = String(opt);
      o.textContent = String(opt);
      o.selected = String(props[f.name]) === String(opt);
      input.appendChild(o);
    }
  } else {
    input = document.createElement('input');
    input.type = f.type === 'number' ? 'number' : 'text';
    input.value = props[f.name] === undefined || props[f.name] === null ? '' : String(props[f.name]);
  }
  input.style.cssText = 'width:100%;padding:6px 8px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:13px;box-sizing:border-box;';
  input.dataset.field = f.name;
  input.dataset.kind = f.type || 'text';
  input.addEventListener('change', () => {
    const raw = input.value;
    const num = Number(raw);
    const numeric = input.dataset.kind === 'number' && raw.trim() !== '' && !Number.isNaN(num);
    helpers.setProp(input.dataset.field, numeric ? num : raw);
  });
  container.appendChild(input);
  if (f.hint) {
    const hint = document.createElement('p');
    hint.textContent = f.hint;
    hint.style.cssText = 'margin:5px 0 0;font-size:11px;color:var(--text-muted);';
    container.appendChild(hint);
  }
}
`.trim();
}

// A one-line readout on the block's own card. `expr` is a statement body
// returning the string to show, so each block decides what its own
// interesting value is without a second copy of the layout code.
function readoutHtml(expr) {
  return `
container.style.display = 'flex';
container.style.flexDirection = 'column';
container.style.alignItems = 'center';
container.style.justifyContent = 'flex-end';
container.style.boxSizing = 'border-box';
container.style.padding = '6px';
container.style.fontFamily = 'Inter, sans-serif';

let val = container.querySelector('.io-readout');
if (!val) {
  val = document.createElement('div');
  val.className = 'io-readout';
  val.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-secondary,#8a94a6);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  container.appendChild(val);
}
val.textContent = (function () { ${expr} })();
`.trim();
}

// Remembers the last value that actually arrived, so a hardware endpoint
// can show what it most recently handled rather than going blank between
// events (nothing is transmitted from the browser — see the section note).
const LAST_SEEN_HTML = readoutHtml(`
const v = inputs.in;
if (v !== undefined) container.dataset.last = typeof v === 'object' ? JSON.stringify(v) : String(v);
return container.dataset.last === undefined ? 'idle' : 'sent: ' + container.dataset.last;
`);

export function createBootBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Boot' });
  block.geometry.width = 150;
  block.geometry.height = 90;
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'boot');
  block.props.push({ id: generateId('prp'), name: 'delay', kind: 'value', value: 0 });
  // Not a setting — where this block records the moment it first ran, so
  // `delay` has something to count from. Clearing it re-arms the block
  // (see the dialog), which is the local stand-in for power-cycling the
  // board the firmware version actually fires on.
  block.props.push({ id: generateId('prp'), name: 'startedAt', kind: 'value', value: 0 });
  block.props.push({
    id: generateId('prp'),
    name: 'fn',
    kind: 'value',
    value: [
      'const startedAt = Number(props.startedAt) || 0;',
      'if (!startedAt) return { out: false, __persist: { startedAt: Date.now() } };',
      'return { out: Date.now() - startedAt >= (Number(props.delay) || 0) };',
    ].join('\n'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'html',
    kind: 'value',
    value: readoutHtml('return outputs.out ? "fired" : "waiting";'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('BOOT', [
      { name: 'delay', label: 'DELAY (MS)', type: 'number', hint: 'How long after start-up this fires. On the device that is power-on; here it is counted from when the block first ran.' },
      { name: 'startedAt', label: 'STARTED AT', type: 'number', hint: 'Set to 0 to re-arm — the local stand-in for power-cycling the board.' },
    ]),
  });
  return finish(nodigraph, block);
}

export function createSerialOutBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Serial TX' });
  block.geometry.width = 170;
  block.geometry.height = 90;
  addNamedPort(block, 'in', 'in');
  addKindProp(block, 'serial');
  for (const [name, value] of [['uart', 2], ['tx', 17], ['rx', 16], ['baud', 115200], ['prefix', '']]) {
    block.props.push({ id: generateId('prp'), name, kind: 'value', value });
  }
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: 'return {};' });
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: LAST_SEEN_HTML });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('SERIAL TX', [
      { name: 'uart', label: 'UART', type: 'number', options: [0, 1, 2] },
      { name: 'tx', label: 'TX PIN', type: 'number' },
      { name: 'rx', label: 'RX PIN', type: 'number' },
      { name: 'baud', label: 'BAUD', type: 'number' },
      { name: 'prefix', label: 'PREFIX', hint: 'Written before every value the device sends.' },
    ]),
  });
  return finish(nodigraph, block);
}

export function createSerialInBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Serial RX' });
  block.geometry.width = 170;
  block.geometry.height = 90;
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'serialin');
  for (const [name, value] of [['uart', 2], ['tx', 17], ['rx', 16], ['baud', 115200], ['prefix', '']]) {
    block.props.push({ id: generateId('prp'), name, kind: 'value', value });
  }
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: 'return {};' });
  block.props.push({
    id: generateId('prp'),
    name: 'html',
    kind: 'value',
    value: readoutHtml('return outputs.out === undefined ? "no data" : String(outputs.out);'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('SERIAL RX', [
      { name: 'uart', label: 'UART', type: 'number', options: [0, 1, 2] },
      { name: 'tx', label: 'TX PIN', type: 'number' },
      { name: 'rx', label: 'RX PIN', type: 'number' },
      { name: 'baud', label: 'BAUD', type: 'number' },
      { name: 'prefix', label: 'PREFIX', hint: 'Lines arriving behind this prefix are what reach out.' },
    ]),
  });
  return finish(nodigraph, block);
}

export function createCanBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'CAN' });
  block.geometry.width = 170;
  block.geometry.height = 90;
  addNamedPort(block, 'in', 'in');
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'can');
  for (const [name, value] of [['tx', 15], ['rx', 16], ['bitrate', 500000], ['textId', 2032], ['format', 'hex']]) {
    block.props.push({ id: generateId('prp'), name, kind: 'value', value });
  }
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: 'return {};' });
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: LAST_SEEN_HTML });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('CAN', [
      { name: 'tx', label: 'TX PIN', type: 'number' },
      { name: 'rx', label: 'RX PIN', type: 'number' },
      { name: 'bitrate', label: 'BITRATE', type: 'number' },
      { name: 'textId', label: 'TEXT ID', type: 'number', hint: 'The dedicated id auto-fragmented plain text is sent under.' },
      { name: 'format', label: 'FORMAT', options: ['hex', 'string'], hint: 'hex is raw ID#DATA frames; string auto-fragments plain text.' },
    ]),
  });
  return finish(nodigraph, block);
}

export function createI2cOutBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'I2C Out' });
  block.geometry.width = 160;
  block.geometry.height = 90;
  addNamedPort(block, 'in', 'in');
  addKindProp(block, 'i2cout');
  block.props.push({ id: generateId('prp'), name: 'addr', kind: 'value', value: 8 });
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: 'return {};' });
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: LAST_SEEN_HTML });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('I2C OUT', [
      { name: 'addr', label: 'ADDRESS', type: 'number', hint: 'The 7-bit device address written to.' },
    ]),
  });
  return finish(nodigraph, block);
}

export function createI2cInBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'I2C In' });
  block.geometry.width = 160;
  block.geometry.height = 90;
  // `in` is a trigger: a signal arriving is what makes the device read.
  addNamedPort(block, 'in', 'in');
  addNamedPort(block, 'out', 'out');
  addKindProp(block, 'i2cin');
  block.props.push({ id: generateId('prp'), name: 'addr', kind: 'value', value: 8 });
  block.props.push({ id: generateId('prp'), name: 'bytes', kind: 'value', value: 1 });
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: 'return {};' });
  block.props.push({
    id: generateId('prp'),
    name: 'html',
    kind: 'value',
    value: readoutHtml('return outputs.out === undefined ? "no read" : String(outputs.out);'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('I2C IN', [
      { name: 'addr', label: 'ADDRESS', type: 'number' },
      { name: 'bytes', label: 'BYTES', type: 'number', hint: 'How many bytes each read requests. A signal on in is what triggers it.' },
    ]),
  });
  return finish(nodigraph, block);
}

export function createPwmOutBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'PWM Out' });
  block.geometry.width = 160;
  block.geometry.height = 90;
  addNamedPort(block, 'in', 'in');
  addKindProp(block, 'pwmout');
  for (const [name, value] of [['gpio', -1], ['freq', 1000], ['duty', 50]]) {
    block.props.push({ id: generateId('prp'), name, kind: 'value', value });
  }
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: 'return {};' });
  block.props.push({
    id: generateId('prp'),
    name: 'html',
    kind: 'value',
    value: readoutHtml('return (inputs.in ? "on " : "off ") + (props.duty === undefined ? "" : props.duty + "%");'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('PWM OUT', [
      { name: 'gpio', label: 'GPIO', type: 'number', hint: '-1 for none.' },
      { name: 'freq', label: 'FREQUENCY (HZ)', type: 'number' },
      { name: 'duty', label: 'DUTY (%)', type: 'number', hint: 'Applied while in is high; the pin is off while it is low.' },
    ]),
  });
  return finish(nodigraph, block);
}

export function createPwmInBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'PWM In' });
  block.geometry.width = 160;
  // Two outputs on the right edge need two slots to sit in (one per 40
  // units — see nodigraph's grid.getPortSlotOffsets).
  block.geometry.height = 120;
  addNamedPort(block, 'out', 'freq');
  addNamedPort(block, 'out', 'duty');
  addKindProp(block, 'pwmin');
  block.props.push({ id: generateId('prp'), name: 'gpio', kind: 'value', value: -1 });
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: 'return {};' });
  block.props.push({
    id: generateId('prp'),
    name: 'html',
    kind: 'value',
    value: readoutHtml('return outputs.freq === undefined ? "no signal" : outputs.freq + "Hz " + outputs.duty + "%";'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('PWM IN', [
      { name: 'gpio', label: 'GPIO', type: 'number', hint: 'The pin measured. Frequency and duty leave on their own outputs.' },
    ]),
  });
  return finish(nodigraph, block);
}

// Pure data handling — runs here exactly as the firmware runs it.
export function createSliceBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Slice' });
  block.geometry.width = 160;
  block.geometry.height = 120;
  addNamedPort(block, 'in', 'in');
  addNamedPort(block, 'out', 'L');
  addNamedPort(block, 'out', 'R');
  addKindProp(block, 'slice');
  block.props.push({ id: generateId('prp'), name: 'splitAt', kind: 'value', value: 1 });
  block.props.push({
    id: generateId('prp'),
    name: 'fn',
    kind: 'value',
    value: [
      'const v = inputs.in;',
      'if (v === undefined) return {};',
      AS_BELT_TEXT,
      'const s = asText(v);',
      'const n = Math.max(0, Math.min(Number(props.splitAt) || 0, s.length));',
      'return { L: s.slice(0, n), R: s.slice(n) };',
    ].join('\n'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'html',
    kind: 'value',
    value: readoutHtml('return outputs.L === undefined ? "—" : JSON.stringify(outputs.L) + " | " + JSON.stringify(outputs.R);'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('SLICE', [
      { name: 'splitAt', label: 'SPLIT AT', type: 'number', hint: 'Characters before this index leave on L, the rest on R.' },
    ]),
  });
  return finish(nodigraph, block);
}

// conucon's belts carry text, and a digital signal on one is the string
// "1" or "0" — that is literally what its `din` block puts on the belt
// (see circuitFireAll in its main.cpp). noditron carries the same signal
// as a JS boolean, so anything here that matches or slices a value as
// TEXT has to render a boolean the way the belt would, or a perfectly
// reasonable rule like "route the 1s here and the 0s there" silently
// compares against "true"/"false" and never matches anything.
const AS_BELT_TEXT = 'const asText = (v) => (typeof v === "boolean" ? (v ? "1" : "0") : String(v));';

// A true demux: `sel` picks which output the value on `in` is forwarded
// to, counting from 0 the way conucon's own route does. out3/out4 ship
// hidden — two ways is the ordinary case (see addNamedPort).
export function createRouteBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Route' });
  block.geometry.width = 170;
  block.geometry.height = 170;
  addNamedPort(block, 'in', 'sel');
  addNamedPort(block, 'in', 'in');
  addNamedPort(block, 'out', 'out1');
  addNamedPort(block, 'out', 'out2');
  addNamedPort(block, 'out', 'out3', { hidden: true });
  addNamedPort(block, 'out', 'out4', { hidden: true });
  addKindProp(block, 'route');
  block.props.push({
    id: generateId('prp'),
    name: 'fn',
    kind: 'value',
    value: [
      'const v = inputs.in;',
      'const sel = Math.trunc(Number(inputs.sel));',
      'if (v === undefined || !Number.isFinite(sel) || sel < 0) return {};',
      '// Selected from 0, the way conucon\'s own route counts. Resolved',
      '// against this block\'s real output names so renaming one in the',
      '// Inspector keeps working (see runtime.js\'s helpers.outputNames).',
      'const names = helpers.outputNames();',
      'return sel < names.length ? { [names[sel]]: v } : {};',
    ].join('\n'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'html',
    kind: 'value',
    value: readoutHtml('const s = Number(inputs.sel); return Number.isFinite(s) ? "→ out" + (Math.trunc(s) + 1) : "no sel";'),
  });
  return finish(nodigraph, block);
}

// Routes by what the value IS rather than by an index: it goes to every
// output whose match text it contains, and to the "else" outputs (those
// with an empty match) only when nothing matched at all — conucon's own
// rule, substring and all.
//
// Named "Match" rather than conucon's "content route": what it does is
// match a value against a list, and "Route" is already the other block
// here (pick an output by number). Its kind stays `croute` — the name on
// the card is cosmetic, the kind is what an export has to emit.
//
// Routes default to ["1", "0"] because a digital signal is the archetypal
// thing to split this way, and that is exactly what those signals look
// like on the belt (see AS_BELT_TEXT).
export function createContentRouteBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Match' });
  block.geometry.width = 180;
  block.geometry.height = 170;
  addNamedPort(block, 'in', 'in');
  addNamedPort(block, 'out', 'out1');
  addNamedPort(block, 'out', 'out2');
  addNamedPort(block, 'out', 'out3', { hidden: true });
  addNamedPort(block, 'out', 'out4', { hidden: true });
  addKindProp(block, 'croute');
  block.props.push({ id: generateId('prp'), name: 'routes', kind: 'value', value: '["1", "0"]' });
  block.props.push({
    id: generateId('prp'),
    name: 'fn',
    kind: 'value',
    value: [
      'const v = inputs.in;',
      'if (v === undefined) return {};',
      AS_BELT_TEXT,
      'const text = asText(v);',
      'let routes = [];',
      'try { routes = JSON.parse(props.routes || "[]"); } catch (err) { routes = []; }',
      'if (!Array.isArray(routes)) routes = [];',
      '// Against the real output names, so renaming one in the Inspector',
      '// keeps working (see runtime.js\'s helpers.outputNames).',
      'const names = helpers.outputNames();',
      'const out = {};',
      'let matched = false;',
      'routes.forEach((m, i) => {',
      '  if (i >= names.length) return;',
      '  if (m !== "" && m !== null && m !== undefined && text.includes(String(m))) {',
      '    out[names[i]] = v;',
      '    matched = true;',
      '  }',
      '});',
      '// An empty match is an "else" row: it fires only when nothing else did.',
      'if (!matched) routes.forEach((m, i) => {',
      '  if (i < names.length && (m === "" || m === null || m === undefined)) out[names[i]] = v;',
      '});',
      'return out;',
    ].join('\n'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'html',
    kind: 'value',
    value: readoutHtml('const hit = Object.keys(outputs); return hit.length ? "→ " + hit.join(", ") : "no match";'),
  });
  block.props.push({
    id: generateId('prp'),
    name: 'dialog',
    kind: 'value',
    value: settingsDialog('MATCH', [
      { name: 'routes', label: 'MATCHES (JSON)', hint: 'One entry per output, in port order — e.g. ["1","0"] to split a digital signal, or ["ok","err",""] for text. A value goes to every output whose text it contains; an empty entry is "else" and fires only when nothing matched. A digital signal reads as "1" or "0", the same as on conucon\'s own belt.' },
    ]),
  });
  return finish(nodigraph, block);
}

// nodigraph's own slim YAML format (model/slimFormat.js over there) is
// generic — built before noditron existed, with no idea `fn`/`render`/
// `html`/`dialog`/`noditronKind` mean anything, so it never wrote them out
// (see that file's own doc on what it deliberately drops). A block pasted
// or imported from that format arrives with its plain-data props restored
// (pin, direction, value, noditronKind, ...) but with no logic behind it
// at all — nothing here special-cased inside nodigraph, so nodigraph
// instead calls this back through an optional host hook (see main.js's
// own window.nodigraphRehydrateBlock, same pattern as
// window.nodigraphDrawBlock/nodigraphCanEnter elsewhere) once per restored
// block, and this is what actually fills the gap back in.
//
// Reuses the real createXBlock functions above rather than a second,
// hand-maintained copy of each kind's fn/render/html/dialog strings —
// building one against a no-op stand-in for `nodigraph` (nothing here
// actually wants a block added to any project, selected, or persisted;
// only the fresh block object itself, to copy its logic props off of) is
// exactly this file's own single source of truth for what each kind's
// default logic is, so the two can never quietly drift apart.
function stubNodigraph() {
  return {
    // nextPosition (see above) reads nodigraph.camera to place a freshly
    // palette-created block on screen -- irrelevant here (only the
    // template's fn/render/html/dialog props ever get read back out), but
    // still has to resolve without throwing.
    camera: { screenToWorld: () => ({ x: 0, y: 0 }) },
    project: { addBlock() {} },
    selection: { select() {} },
    renderLoop: { requestRender() {} },
    persist() {},
  };
}

const CREATE_BY_KIND = {
  'digital-io': createDigitalIOBlock,
  and: createAndBlock,
  or: createOrBlock,
  add: createAddBlock,
  gate: createGateBlock,
  not: createNotBlock,
  led: createLedBlock,
  state: createStateBlock,
  timer: createTimerBlock,
  weather: createWeatherBlock,
  'json-field': createJsonFieldBlock,
  // conucon's own type names, deliberately (see that section's note).
  boot: createBootBlock,
  serial: createSerialOutBlock,
  serialin: createSerialInBlock,
  can: createCanBlock,
  i2cout: createI2cOutBlock,
  i2cin: createI2cInBlock,
  pwmout: createPwmOutBlock,
  pwmin: createPwmInBlock,
  slice: createSliceBlock,
  route: createRouteBlock,
  croute: createContentRouteBlock,
};

const CODE_PROP_NAMES = ['fn', 'render', 'html', 'dialog'];

function setProp(block, name, value) {
  const existing = (block.props || []).find((p) => p.name === name);
  if (existing) existing.value = value;
  else block.props.push({ id: generateId('prp'), name, kind: 'value', value });
}

// The built-in Data `fn` exactly as it stood before `in` became a trigger:
// a wired input passed straight through to `out`, overriding the stored
// constant. A block still carrying this string byte-for-byte has never
// been hand-edited, which is what makes it safe to move onto the current
// behavior (see createDataBlock's own note on what changed).
// Each entry is a *previous built-in default*, never anything a person
// typed: the original pass-through, then the first trigger version, then
// the one that added a `fired` pulse for an on-canvas lamp. The latter two
// both latched `write` through helpers.changed, which silently ignored a
// steady value — see DATA_FN on why that had to go.
const LEGACY_DATA_FN_SOURCES = [
  'return { out: inputs.in !== undefined ? inputs.in : props.value };',
  [
    'const incoming = inputs.write;',
    "if (incoming !== undefined && helpers.changed('write', incoming)) {",
    '  return { out: incoming, __persist: { value: incoming } };',
    '}',
    'return { out: props.value };',
  ].join('\n'),
  [
    "const fired = inputs.in !== undefined && helpers.changed('in', inputs.in);",
    'const incoming = inputs.write;',
    "if (incoming !== undefined && helpers.changed('write', incoming)) {",
    '  return { out: incoming, fired, __persist: { value: incoming } };',
    '}',
    'return { out: props.value, fired };',
  ].join('\n'),
  // Fixed the write latch, but `out` was still continuous, so a trigger
  // arriving produced no visible change on the wire at all.
  [
    'const incoming = inputs.write;',
    'if (incoming !== undefined && JSON.stringify(incoming) !== JSON.stringify(props.value)) {',
    '  return { out: incoming, __persist: { value: incoming } };',
    '}',
    'return { out: props.value };',
  ].join('\n'),
  // Pulsed, but decided trigger-vs-constant from whether a value happened
  // to be in flight rather than from whether `in` is wired at all — so a
  // block wired to something momentarily quiet fell back to behaving like
  // a constant (see helpers.isWired).
  [
    'const incoming = inputs.write;',
    'if (incoming !== undefined && JSON.stringify(incoming) !== JSON.stringify(props.value)) {',
    '  return { out: incoming, __persist: { value: incoming } };',
    '}',
    'if (inputs.in === undefined) return { out: props.value };',
    "return helpers.changed('in', inputs.in) ? { out: props.value } : {};",
  ].join('\n'),
  [
    'const incoming = inputs.write;',
    'if (incoming !== undefined && JSON.stringify(incoming) !== JSON.stringify(props.value)) {',
    '  return { out: incoming, __persist: { value: incoming } };',
    '}',
    "if (!helpers.isWired('in')) return { out: props.value };",
    "return helpers.changed('in', inputs.in) ? { out: props.value } : {};",
  ].join('\n'),
];

// Brings an existing Data block up to what a freshly created one is now:
// current fn and html, plus the hidden `write` port it may predate.
//
// "Stock" is the gate, and it is deliberately strict — the block's fn has
// to be byte-identical to the current default or to one of the previous
// ones above. A fn someone actually wrote matches none of them and the
// block is left completely alone, code and markup both, which is the same
// principle rehydrateKindLogic below works on. Once a block IS stock, both
// props are refreshed rather than only the one that happened to change, so
// a fix to the html alone (the card reading `out` instead of the stored
// value, say) still reaches blocks already placed.
//
// Returns whether it actually changed anything — a block already current
// reports false, so this can run on every load without marking the project
// dirty and re-persisting it each time.
//
// This exists because the alternative is worse: an older diagram would
// otherwise hold two kinds of Data block that look identical and behave
// differently, one passing its input through and one triggering.
export function migrateLegacyDataBlock(block) {
  if ((block.props || []).find((p) => p.name === KIND_PROP)?.value !== 'data') return false;
  const fn = (block.props || []).find((p) => p.name === 'fn');
  if (!fn) return false;
  const source = String(fn.value).trim();
  if (source !== DATA_FN && !LEGACY_DATA_FN_SOURCES.includes(source)) return false;

  let changed = false;
  if (source !== DATA_FN) {
    fn.value = DATA_FN;
    changed = true;
  }
  if (String((block.props || []).find((p) => p.name === 'html')?.value ?? '') !== DATA_HTML) {
    setProp(block, 'html', DATA_HTML);
    changed = true;
  }
  // A Data block living as a container's named child has no ports at all
  // and wants none (see createDataBlock's `withPort`) — but such a child
  // never carried one of the fns above either, so reaching here at all
  // means this is a standalone one.
  if (!(block.ports || []).some((pin) => logicalPortOf(block, pin)?.name === 'write')) {
    addNamedPort(block, 'in', 'write', { hidden: true });
    changed = true;
  }
  // Blocks placed before the name moved off the centre of the card (see
  // titleAtTop) would otherwise keep drawing their value on top of it.
  if (block.style?.titlePos !== 'top') {
    titleAtTop(block);
    changed = true;
  }
  if (changed) block.description = serializeBlockDescription(block);
  return changed;
}

// Only ever fills in what's actually missing — a block that already has
// real `fn` content (hand-customized via the Logic tab, or arrived through
// a full-fidelity path like nodigraph's own JSON clipboard/file format,
// which never had this gap to begin with) is left completely alone. That
// makes this safe to call unconditionally on every block a generic
// nodigraph import produces, never just the ones known to need it.
export function rehydrateKindLogic(block) {
  if ((block.props || []).find((p) => p.name === 'fn')?.value) return;
  const kind = (block.props || []).find((p) => p.name === KIND_PROP)?.value;

  // The one kind whose fn genuinely depends on the instance rather than
  // being a fixed template — see createDataBlock's own doc on withPort: a
  // standalone Data block has real in/out ports, one living as a settings
  // child (Timer's T_ON/T_OFF, JSON Field's KEY) has none, and slim YAML
  // already restores ports faithfully, so that's read straight off the
  // block being rehydrated rather than needing its own stub.
  if (kind === 'data') {
    const withPort = (block.ports || []).length > 0;
    setProp(block, 'fn', withPort ? DATA_FN : 'return { out: props.value };');
    // A standalone Data block gets its trigger input alongside the rest of
    // its logic — an import that restored ports faithfully already has it,
    // so this only ever fires for one that predates the port existing.
    if (withPort && !(block.ports || []).some((pin) => logicalPortOf(block, pin)?.name === 'write')) {
      addNamedPort(block, 'in', 'write', { hidden: true });
    }
    setProp(block, 'html', DATA_HTML);
    setProp(block, 'dialog', DATA_DIALOG);
    return;
  }

  const create = CREATE_BY_KIND[kind];
  if (!create) return; // Not one of noditron's own kinds (or no kind at all) -- nothing this file knows how to rebuild.
  const template = create(stubNodigraph());
  for (const name of CODE_PROP_NAMES) {
    const src = template.props.find((p) => p.name === name);
    if (src) setProp(block, name, src.value);
  }
}

export function mountPalette(nodigraph, container) {
  container.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'noditron-palette-label';
  label.textContent = 'Add block';
  container.appendChild(label);

  // { el, kind } for every button -- kept around so refresh() (see below)
  // can show/hide by kind against whatever the current container allows,
  // without rebuilding the whole palette (and losing click listeners,
  // scroll position, etc.) every time the user navigates a level.
  const buttons = [];
  function paletteButton(swatchColor, text, kind, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    const swatch = document.createElement('span');
    swatch.className = 'noditron-swatch';
    swatch.style.background = swatchColor;
    const label_ = document.createElement('span');
    label_.textContent = text;
    button.append(swatch, label_);
    // Into the selected block, when one is selected (see prepareAdd) —
    // before onClick, which places the new block in view of the camera the
    // move leaves behind.
    button.addEventListener('click', () => {
      prepareAdd(nodigraph);
      onClick();
    });
    container.appendChild(button);
    buttons.push({ el: button, kind });
    return button;
  }

  paletteButton('#3ecf5d', 'Bool', 'digital-io', () => createDigitalIOBlock(nodigraph));
  paletteButton('#4f8cff', 'Data', 'data', () => createStandaloneDataBlock(nodigraph));
  paletteButton('#4f8cff', 'Add', 'add', () => createAddBlock(nodigraph));
  paletteButton('#c98a2f', 'AND gate', 'and', () => createAndBlock(nodigraph));
  paletteButton('#c98a2f', 'OR gate', 'or', () => createOrBlock(nodigraph));
  paletteButton('#c98a2f', 'Gate', 'gate', () => createGateBlock(nodigraph));
  paletteButton('#c98a2f', 'NOT gate', 'not', () => createNotBlock(nodigraph));
  paletteButton('#7c5cff', 'State', 'state', () => createStateBlock(nodigraph));
  paletteButton('#3ecf5d', 'LED', 'led', () => createLedBlock(nodigraph));
  paletteButton('#3ecf5d', 'Timer', 'timer', () => createTimerBlock(nodigraph));
  paletteButton('#2f6fed', 'Weather', 'weather', () => createWeatherBlock(nodigraph));
  paletteButton('#c98a2f', 'JSON Field', 'json-field', () => createJsonFieldBlock(nodigraph));

  // conucon's Logic Module blocks (see that section in this file).
  paletteButton('#7c5cff', 'Boot', 'boot', () => createBootBlock(nodigraph));
  paletteButton('#c98a2f', 'Slice', 'slice', () => createSliceBlock(nodigraph));
  paletteButton('#c98a2f', 'Route', 'route', () => createRouteBlock(nodigraph));
  paletteButton('#c98a2f', 'Match', 'croute', () => createContentRouteBlock(nodigraph));
  paletteButton('#3ecf5d', 'PWM Out', 'pwmout', () => createPwmOutBlock(nodigraph));
  paletteButton('#3ecf5d', 'PWM In', 'pwmin', () => createPwmInBlock(nodigraph));
  paletteButton('#2f6fed', 'Serial TX', 'serial', () => createSerialOutBlock(nodigraph));
  paletteButton('#2f6fed', 'Serial RX', 'serialin', () => createSerialInBlock(nodigraph));
  paletteButton('#2f6fed', 'CAN', 'can', () => createCanBlock(nodigraph));
  paletteButton('#2f6fed', 'I2C Out', 'i2cout', () => createI2cOutBlock(nodigraph));
  paletteButton('#2f6fed', 'I2C In', 'i2cin', () => createI2cInBlock(nodigraph));

  // Called on every navigation (see main.js's own level-change poll) --
  // hides any button whose kind isn't in the current container's own
  // allowedChildKinds, if it declares one (see containerRestrictions.js).
  // Unrestricted containers (no prop set -- the ordinary case) show every
  // primitive, exactly as before this existed.
  function refresh() {
    const allowed = getAllowedChildKinds(nodigraph);
    for (const { el, kind } of buttons) {
      // Not el.hidden -- #noditron-palette button's own display:flex rule
      // (id+element, higher specificity than the UA [hidden]{display:none}
      // default) would silently win and leave it visible anyway.
      el.style.display = allowed !== null && !allowed.includes(kind) ? 'none' : '';
    }
  }
  refresh();
  return { refresh };
}
