// The "3 simple nodes to pick" palette. Every block it creates is built
// entirely through nodigraph's own public model API (createBlock, addPort,
// project.addBlock, ...) — exactly what a person clicking nodigraph's own
// "+ Add block" / "+ Add port" buttons would produce, just done in code and
// pre-wired with the right ports and a `noditronKind` prop (see runtime.js)
// up front. Nothing here is special-cased inside nodigraph itself.
import { createBlock, generateId } from '/nodigraph/src/model/Block.js';
import { addPort, logicalPortOf, serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { KIND_PROP } from './runtime.js';

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

export function createBoolBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Bool' });
  addNamedPort(block, 'out', 'out');
  addNamedPort(block, 'out', 'changed');
  // The slider (see BlockDescription's min..max = value range prop, and
  // InspectorPanel's slider rendering for it) — select the block to set it.
  // The on-canvas click-to-toggle (see canvasIndicators.js) is the quicker way.
  block.props.push({ id: generateId('prp'), name: 'value', kind: 'range', min: 0, max: 1, value: 0 });
  addKindProp(block, 'bool');
  addLogicProps(
    block,
    `return { out: Number(props.value) >= 1, changed: ${changedExpr()} };`,
    // This dot IS what's on screen — draws exactly like any other
    // block's indicator (see canvasIndicators.js), just seeded with
    // `outputs.out` (this block's own already-computed value, from
    // Function above) and a different default colour. Only *clicking*
    // it is special-cased, not the drawing — edit this freely.
    "helpers.dot(Boolean(outputs.out), '#4f8cff');",
  );
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

// Demonstrates all three customization axes at once (see logicTab.js's own
// intro text): Function (fn) computes the output the same way Bool does;
// HTML (html) replaces this block's on-canvas body entirely with a real
// title/readout/slider instead of a drawn dot; Dialog (dialog) gives it a
// proper settings panel (GPIO pin, an emit-on-change checkbox, the sim
// test-value range) instead of raw code fields. Every value either widget
// touches lives in ordinary props — pin/value/emitOnChange — so both
// stay in sync with each other and with Function for free.
const DIN_HTML = `
container.style.position = 'relative';
container.style.display = 'flex';
container.style.flexDirection = 'column';
container.style.justifyContent = 'space-between';
container.style.boxSizing = 'border-box';
container.style.padding = '8px 10px';
container.style.fontFamily = 'Inter, sans-serif';

let title = container.querySelector('.din-title');
if (!title) {
  title = document.createElement('div');
  title.className = 'din-title';
  title.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--success,#3ecf5d);';
  title.textContent = 'DIN';

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'din-gear';
  gear.textContent = String.fromCharCode(9881);
  gear.title = 'Configure';
  gear.style.cssText = 'position:absolute;top:4px;right:4px;width:20px;height:20px;padding:0;border-radius:5px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:11px;line-height:1;cursor:pointer;';
  gear.addEventListener('click', helpers.openDialog);

  const readout = document.createElement('div');
  readout.className = 'din-readout';
  readout.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;color:var(--success,#3ecf5d);';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'din-slider';
  slider.min = '0';
  slider.max = '1';
  slider.step = '1';
  slider.style.width = '100%';
  slider.addEventListener('input', () => helpers.setProp('value', Number(slider.value)));

  container.append(title, gear, readout, slider);
}

const pin = block.props.find((p) => p.name === 'pin')?.value ?? '?';
container.querySelector('.din-readout').textContent = String(pin);

const slider = container.querySelector('.din-slider');
if (document.activeElement !== slider) {
  slider.value = String(Number(block.props.find((p) => p.name === 'value')?.value || 0));
}
`.trim();

const DIN_DIALOG = `
container.style.fontFamily = 'Inter, sans-serif';

const heading = document.createElement('h3');
heading.textContent = 'DIGITAL INPUT';
heading.style.cssText = 'margin:0 0 14px;color:var(--success,#3ecf5d);font-size:15px;letter-spacing:.03em;';
container.appendChild(heading);

function section(labelText) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:16px;';
  if (labelText) {
    const label = document.createElement('div');
    label.textContent = labelText;
    label.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px;';
    wrap.appendChild(label);
  }
  container.appendChild(wrap);
  return wrap;
}

const fieldStyle = 'width:100%;padding:6px 8px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:13px;box-sizing:border-box;';

const pinSection = section('GPIO PIN');
const pinSelect = document.createElement('select');
pinSelect.style.cssText = fieldStyle;
for (let i = 0; i <= 39; i += 1) {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = 'GPIO ' + i;
  pinSelect.appendChild(opt);
}
pinSelect.value = String(props.pin ?? 2);
pinSelect.addEventListener('change', () => helpers.setProp('pin', Number(pinSelect.value)));
pinSection.appendChild(pinSelect);

const pinHint = document.createElement('p');
pinHint.textContent = 'Input-only pins (34-39) cannot be used for output.';
pinHint.style.cssText = 'margin:6px 0 0;font-size:11px;color:var(--text-muted);';
pinSection.appendChild(pinHint);

const emitSection = section('');
const emitRow = document.createElement('label');
emitRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;cursor:pointer;';
const emitCheckbox = document.createElement('input');
emitCheckbox.type = 'checkbox';
emitCheckbox.checked = Boolean(props.emitOnChange);
emitCheckbox.addEventListener('change', () => helpers.setProp('emitOnChange', emitCheckbox.checked));
const emitText = document.createElement('div');
const emitTitle = document.createElement('div');
emitTitle.textContent = 'Emit signal when value changes';
emitTitle.style.cssText = 'font-size:12px;font-weight:600;';
const emitDesc = document.createElement('div');
emitDesc.textContent = 'Fires 1 (rising) or 0 (falling) on the output when the GPIO state changes.';
emitDesc.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:2px;';
emitText.append(emitTitle, emitDesc);
emitRow.append(emitCheckbox, emitText);
emitSection.appendChild(emitRow);

const rangeSection = section('DATA RANGE (SIM TEST VALUE)');
const rangeRow = document.createElement('div');
rangeRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
const minBox = document.createElement('input');
minBox.type = 'number';
minBox.value = '0';
minBox.disabled = true;
minBox.style.cssText = 'width:48px;flex:none;' + fieldStyle;
const slider = document.createElement('input');
slider.type = 'range';
slider.min = '0';
slider.max = '1';
slider.step = '1';
slider.value = String(Number(props.value || 0));
slider.style.flex = '1';
const maxBox = document.createElement('input');
maxBox.type = 'number';
maxBox.value = '1';
maxBox.disabled = true;
maxBox.style.cssText = minBox.style.cssText;
rangeRow.append(minBox, slider, maxBox);
rangeSection.appendChild(rangeRow);

const readoutCaption = document.createElement('p');
readoutCaption.style.cssText = 'margin:8px 0 0;font-size:11px;color:var(--text-muted);';
function describe(v) { return (Number(v) >= 1 ? '1 -> HIGH' : '0 -> LOW') + ' (bound to a digital pin)'; }
readoutCaption.textContent = describe(props.value);
slider.addEventListener('input', () => {
  helpers.setProp('value', Number(slider.value));
  readoutCaption.textContent = describe(slider.value);
});
rangeSection.appendChild(readoutCaption);

const note = document.createElement('p');
note.textContent = "Drives this block's simulated GPIO reading -- used whenever no physical pin is actually wired in.";
note.style.cssText = 'margin:0;font-size:11px;color:var(--text-muted);';
container.appendChild(note);
`.trim();

export function createDigitalInputBlock(nodigraph) {
  const { x, y } = nextPosition(nodigraph);
  const block = createBlock({ x, y, name: 'Digital Input' });
  // Cleared right after creation, not passed as `name` above — createBlock
  // treats an empty string the same as "not given" and falls back to "New
  // Block" (see its own `name || 'New Block'`). Blank because nodigraph
  // always draws a block's own name centered (see BlockRenderer.drawBlock),
  // and with the html overlay having no background of its own (per
  // instruction — nodigraph's own block fill shows through instead), that
  // centered text would otherwise collide with the readout DIN_HTML draws
  // in roughly the same spot. The "DIN" title inside DIN_HTML is this
  // block's only label now — rename it in the Inspector if you want
  // something else there.
  block.name = '';
  addNamedPort(block, 'out', 'out');
  block.props.push({ id: generateId('prp'), name: 'pin', kind: 'value', value: 2 });
  block.props.push({ id: generateId('prp'), name: 'value', kind: 'range', min: 0, max: 1, value: 0 });
  block.props.push({ id: generateId('prp'), name: 'emitOnChange', kind: 'value', value: false });
  block.props.push({ id: generateId('prp'), name: 'fn', kind: 'value', value: 'return { out: Number(props.value) >= 1 };' });
  block.props.push({ id: generateId('prp'), name: 'html', kind: 'value', value: DIN_HTML });
  block.props.push({ id: generateId('prp'), name: 'dialog', kind: 'value', value: DIN_DIALOG });
  return finish(nodigraph, block);
}

// Like Bool (see createBoolBlock) but holds any value, not just 0/1 — a
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
container.style.position = 'relative';
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
  // See createDigitalInputBlock's own note on why: no background on the
  // html card means nodigraph's own centered name would otherwise collide
  // with this card's title/readout.
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

  function paletteButton(swatchColor, text, onClick) {
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
    return button;
  }

  paletteButton('#4f8cff', 'Bool', () => createBoolBlock(nodigraph));
  paletteButton('#4f8cff', 'Data', () => createStandaloneDataBlock(nodigraph));
  paletteButton('#c98a2f', 'AND gate', () => createAndBlock(nodigraph));
  paletteButton('#3ecf5d', 'LED', () => createLedBlock(nodigraph));
  paletteButton('#3ecf5d', 'Digital Input', () => createDigitalInputBlock(nodigraph));
  paletteButton('#3ecf5d', 'Timer', () => createTimerBlock(nodigraph));
  paletteButton('#2f6fed', 'Weather', () => createWeatherBlock(nodigraph));
  paletteButton('#c98a2f', 'JSON Field', () => createJsonFieldBlock(nodigraph));
}
