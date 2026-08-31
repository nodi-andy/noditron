// The "3 simple nodes to pick" palette. Every block it creates is built
// entirely through nodigraph's own public model API (createBlock, addPort,
// project.addBlock, ...) — exactly what a person clicking nodigraph's own
// "+ Add block" / "+ Add port" buttons would produce, just done in code and
// pre-wired with the right ports and a `noditronKind` prop (see runtime.js)
// up front. Nothing here is special-cased inside nodigraph itself.
import { createBlock, generateId } from '/nodigraph/src/model/Block.js';
import { addPort, logicalPortOf, serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { KIND_PROP } from './runtime.js';
import { getAllowedChildKinds } from './containerRestrictions.js';

function addNamedPort(block, direction, name) {
  const pin = addPort(block, { direction });
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

function finish(nodigraph, block) {
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

// `changed` (see runtime.js's own helpers.changed/portsSignature) pulses
// true for exactly one tick whenever this block's own value is edited
// (the slider, the on-canvas toggle, its dialog — anything that touches
// `props.value`) or its port gets rewired to something else — a separate
// port from `out` on purpose, since `out` has to keep carrying the actual
// value every tick for whatever reads it; a momentary pulse living on the
// same port would corrupt that. Wire `changed` into something that wants
// to react only *when* a primitive is touched rather than poll it
// continuously — Weather's own `trigger`, for instance.
function changedExpr() {
  return "helpers.changed('state', { value: props.value, wiring: helpers.portsSignature() })";
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
    // Output is the settable direction (drives a real GPIO or stands in as
    // a manual constant when unwired) -- input is a read-only reflection of
    // whatever feeds it (a wire, or a connected board's own live reading).
    if (dir !== 'output') return;
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
const direction = ((block.props.find((p) => p.name === 'direction') || {}).value) === 'output' ? 'output' : 'input';
badge.textContent = (pin === null || pin === undefined || pin === '' ? 'SIM' : 'GPIO' + pin) + ' · ' + direction.toUpperCase();

const dot = container.querySelector('.dio-dot');

// For a real input pin nested inside a connected, running ESP32 DevKit,
// prefer the board's own live reading over the locally-computed value.
// livePins.js is a shared poll cache (one poller per board, not one per
// block, so several Input blocks reading the same board don't each run
// their own readPins() loop against the same serial link) -- loaded lazily
// and cached on window since this html script is recompiled and re-run
// fresh every frame, with no other way to keep a reference across calls.
let liveState = null;
if (direction === 'input' && pin !== null && pin !== undefined && pin !== '') {
  if (!window.__noditronLivePins) {
    window.__noditronLivePins = { mod: null };
    import('/src/livePins.js').then((m) => { window.__noditronLivePins.mod = m; });
  }
  const livePins = window.__noditronLivePins.mod;
  if (livePins) {
    const parent = window.nodigraph?.project?.getContainerBlock?.();
    const parentKind = parent && (parent.props || []).find((p) => p.name === 'noditronKind')?.value;
    const parentState = parent && (parent.props || []).find((p) => p.name === 'connectionState')?.value;
    if (parentKind === 'esp32-devkit' && parentState === 'connected:running') {
      livePins.ensurePolling(parent.id);
      const cached = livePins.getCachedPins(parent.id);
      const match = cached && cached.find((p) => Number(p.gpio) === Number(pin));
      if (match) liveState = Boolean(match.state);
    }
  }
}

// Output shows the wired-in value when something actually feeds its 'in'
// port, else falls back to its own manually-set value prop (the "acts as
// a manual constant when unwired" case the click handler above writes to).
const outputWired = inputs.value !== undefined;
const currentValueProp = block.props.find((p) => p.name === 'value');
const on = liveState !== null
  ? liveState
  : direction === 'input'
    ? Boolean(outputs.value)
    : (outputWired ? Boolean(inputs.value) : Number(currentValueProp && currentValueProp.value) >= 1);
dot.style.background = on ? '#3ecf5d' : 'transparent';
dot.style.borderColor = on ? '#3ecf5d' : 'var(--border)';
dot.style.cursor = direction === 'output' ? 'pointer' : 'default';
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

const dirSection = section('DIRECTION');
const dirSelect = document.createElement('select');
dirSelect.style.cssText = fieldStyle;
[['input', 'Input (reads a signal)'], ['output', 'Output (drives a signal)']].forEach(([value, label]) => {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  dirSelect.appendChild(opt);
});
dirSelect.value = props.direction === 'output' ? 'output' : 'input';
dirSection.appendChild(dirSelect);

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
pinSelect.addEventListener('change', () => helpers.setProp('pin', pinSelect.value === '' ? null : Number(pinSelect.value)));
pinSection.appendChild(pinSelect);

const pinHint = document.createElement('p');
pinHint.textContent = 'The value below always simulates locally too, connected or not. If this block sits directly inside a connected, running ESP32 DevKit and has a real pin set, an Output also drives the real GPIO live.';
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
// Output is the settable direction (drives a real GPIO, or stands in as a
// manual constant when unwired) -- input is read-only, a reflection of
// whatever feeds it. See this block's own html prop (DIGITAL_IO_HTML) for
// the matching on-canvas dot, which follows the same rule.
slider.disabled = dirSelect.value === 'input';
const readout = document.createElement('span');
readout.style.cssText = 'font-size:12px;color:var(--text-muted);min-width:34px;';
function describe(v) { return Number(v) >= 1 ? 'HIGH' : 'LOW'; }
readout.textContent = describe(props.value);
slider.addEventListener('input', async () => {
  const next = Number(slider.value);
  helpers.setProp('value', next);
  readout.textContent = describe(slider.value);
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
if (dirSelect.value === 'input') {
  const inHint = document.createElement('p');
  inHint.textContent = 'Read-only -- an input reflects whatever is wired into it, or the live reading from a connected board. Switch to Output to set it by hand.';
  inHint.style.cssText = 'margin:6px 0 0;font-size:11px;color:var(--text-muted);';
  valueSection.appendChild(inHint);
}

dirSelect.addEventListener('change', async () => {
  const dir = dirSelect.value;
  helpers.setProp('direction', dir);
  const bd = await import('/nodigraph/src/model/BlockDescription.js');
  for (const lp of [...(block.logicalPorts || [])]) {
    const removedPinIds = bd.removeLogicalPort(block, lp.id);
    for (const pinId of removedPinIds) helpers.project.removeConnectionsForPort(pinId);
  }
  bd.addPort(block, { direction: dir === 'output' ? 'in' : 'out' });
  const newLogical = block.logicalPorts[block.logicalPorts.length - 1];
  if (newLogical) newLogical.name = 'value';
  block.description = bd.serializeBlockDescription(block);
  helpers.refresh();
  helpers.close();
});
`.trim();

export function createDigitalIOBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Bool' });
  addNamedPort(block, 'out', 'value');
  block.props.push({ id: generateId('prp'), name: 'pin', kind: 'value', value: null });
  block.props.push({ id: generateId('prp'), name: 'direction', kind: 'value', value: 'input' });
  block.props.push({ id: generateId('prp'), name: 'value', kind: 'range', min: 0, max: 1, value: 0 });
  addKindProp(block, 'digital-io');
  addLogicProps(
    block,
    `return { value: Number(props.value) >= 1, changed: ${changedExpr()} };`,
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
// wire something into it and that overrides the block's own constant on
// `out` for as long as the wire's there (unwire it and `out` falls back to
// the constant again); this is what lets a Data block work as a live
// readout for something else's output — Weather's current temperature,
// say — not just a source. One living inside a container as a named
// child (see createTimerBlock's T_ON/T_OFF) skips both ports entirely —
// nothing there ever wires it, only reads its value by name (see
// runtime.js's helpers.childValue), so a port would just be dead weight.
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
// outputs.out, not the raw value prop directly — this is what makes an
// incoming wire actually show up here instead of just the stored constant
// (see the fn this block is seeded with).
const v = outputs.out;
val.textContent = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
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
hint.textContent = "A plain constant — numbers work as-is, anything else is kept as text. Ignored while something is wired into this block's own in port; out follows the wire instead until it's disconnected.";
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
    value: withPort ? 'return { out: inputs.in !== undefined ? inputs.in : props.value };' : 'return { out: props.value };',
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
    button.addEventListener('click', onClick);
    container.appendChild(button);
    buttons.push({ el: button, kind });
    return button;
  }

  paletteButton('#3ecf5d', 'Bool', 'digital-io', () => createDigitalIOBlock(nodigraph));
  paletteButton('#4f8cff', 'Data', 'data', () => createStandaloneDataBlock(nodigraph));
  paletteButton('#c98a2f', 'AND gate', 'and', () => createAndBlock(nodigraph));
  paletteButton('#3ecf5d', 'LED', 'led', () => createLedBlock(nodigraph));
  paletteButton('#3ecf5d', 'Timer', 'timer', () => createTimerBlock(nodigraph));
  paletteButton('#2f6fed', 'Weather', 'weather', () => createWeatherBlock(nodigraph));
  paletteButton('#c98a2f', 'JSON Field', 'json-field', () => createJsonFieldBlock(nodigraph));

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
