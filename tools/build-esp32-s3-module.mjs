#!/usr/bin/env node
// Builds modules/esp32-s3-devkit/noditron.module.json's board pins.
//
//   node tools/build-esp32-s3-module.mjs
//
// Regenerates the Waveshare board's ports and canvas drawing, preserving
// its connection dialog. The library ID stays stable for existing installs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(here, '..', 'modules', 'esp32-s3-devkit', 'noditron.module.json');
const CLASSIC_PATH = path.join(here, '..', 'modules', 'esp32-devkit', 'noditron.module.json');

// Waveshare ESP32-S3-POE-ETH-8DI-8DO:
// https://www.waveshare.com/wiki/ESP32-S3-POE-ETH-8DI-8DO
// EXIO virtual GPIOs 1000..1007 match conucon's live IO protocol.
const LEFT = Array.from({ length: 8 }, (_, i) => ['DI' + (i + 1), i + 4, 'digital-input']);
const RIGHT = Array.from({ length: 8 }, (_, i) => ['DO' + (i + 1), 1000 + i, 'digital-output']);
LEFT.push(['CAN In', 3, 'can-in']);
RIGHT.push(['CAN Out', 2, 'can-out'], ['CAN speed', null, 'can-speed']);
RIGHT.push(['RS485 TX', 17, 'rs485'], ['RS485 RX', 18, 'rs485']);
const RESERVED = new Map([[17, 'RS485 TX'], [18, 'RS485 RX']]);
const NOTES = new Map();

const PIN_SPACING = 40;
const FIRST_PIN_OFFSET = 30;

function pinEntry([label, gpio, role], side, row) {
  return {
    label,
    gpio,
    role,
    // The S3 has no input-only pins at all, unlike the classic ESP32's
    // 34/35/36/39 — every GPIO it brings out can drive as well as read.
    inputOnly: role === 'digital-input' || role === 'can-in',
    outputOnly: role === 'digital-output' || role === 'can-out' || role === 'can-speed',
    ...(role === 'digital-output' ? { exio: gpio - 999, note: 'TCA9554 EXIO' + (gpio - 999) + ' / isolated Darlington output' } : {}),
    side,
    row,
    orientation: 'usb-top',
    ...(gpio !== null && RESERVED.has(gpio) ? { reserved: RESERVED.get(gpio) } : {}),
    ...(gpio !== null && NOTES.has(gpio) ? { note: NOTES.get(gpio) } : {}),
  };
}

function build() {
  const pins = [
    ...LEFT.map((p, i) => pinEntry(p, 'left', i)),
    ...RIGHT.map((p, i) => pinEntry(p, 'right', i)),
    // The USB socket, as the classic module does it: a pin with no GPIO
    // behind it, carrying the board's serial link to whatever is wired to
    // it (see devkitCircuit.js's usb-serial handling).
    { label: 'USB', gpio: null, role: 'usb-serial', inputOnly: null, side: 'top', row: null, orientation: 'usb-top' },
  ];

  // One port per pin, each pinned to its own slot down the edge. Ports on
  // the same side may not share a slot, so the row spacing is the slot
  // spacing; `manualOffset` keeps nodigraph from re-flowing them.
  const ports = [];
  const logicalPorts = [];
  const seen = new Map();
  for (const pin of pins) {
    // Several rails share a label (three GNDs, two 3V3s); the id has to be
    // unique even where the name is not.
    const slug = pin.label.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const n = (seen.get(slug) || 0) + 1;
    seen.set(slug, n);
    const base = `esp32s3_${pin.side}_${slug}_${n}`;
    const offset = pin.side === 'top'
      ? Math.round(300 / 2 / PIN_SPACING) * PIN_SPACING - 10
      : FIRST_PIN_OFFSET + pin.row * PIN_SPACING;
    logicalPorts.push({
      id: `io_${base}`,
      name: pin.label,
      // Use the PCB terminal direction on the block face. Nodigraph
      // automatically inverts a container port when viewed from inside,
      // so DI becomes an inner source and DO an inner sink as required.
      direction: pin.inputOnly ? 'in' : pin.outputOnly ? 'out' : null,
      description: pin.reserved
        ? `GPIO${pin.gpio} — unavailable: ${pin.reserved}`
        : pin.gpio === null
          ? pin.role
          : pin.note
            ? `GPIO${pin.gpio} — ${pin.note}`
            : `GPIO${pin.gpio}`,
    });
    ports.push({ id: `prt_${base}`, logicalId: `io_${base}`, side: pin.side, offset, manualOffset: true });
  }

  const rows = Math.max(LEFT.length, RIGHT.length);
  const height = FIRST_PIN_OFFSET + (rows - 1) * PIN_SPACING + 70;
  return { pins, ports, logicalPorts, geometry: { x: 0, y: 0, width: 300, height } };
}

// The classic drawing's USB connector box under the USB pin. This board
// keeps the USB *pin* — it is the serial link a circuit can talk over —
// but not a drawn socket for it: the pin on the edge already says where
// USB is, and the box was a second, larger label for the same thing.
const USB_BOX = /\n\/\/ The USB connector sits under[\s\S]*?ctx\.fillText\('USB', usbX, g\.y \+ 29\);\n/;

// Reuse the board drawing with this PCB's name, reset button and RGB pin.
function renderSource(boardName) {
  const classic = JSON.parse(fs.readFileSync(CLASSIC_PATH, 'utf8'));
  const source = Object.values(classic.block.blocks)[0].props.find((p) => p.name === 'render').value;
  if (!USB_BOX.test(source)) throw new Error('classic render no longer has the USB connector box this strips');
  return source
    .replace(USB_BOX, '\n')
    .replace("block.name || 'ESP32 DevKit'", `block.name || '${boardName}'`)
    .replace(
      "drawBoardButton(g.x + g.width / 2 + 72, 'GPIO35', '#f8fafc');",
      "drawBoardButton(g.x + g.width / 2 + 72, 'RESET', '#f8fafc');",
    )
    .replace("ctx.fillText('LED GPIO2', g.x + g.width / 2, topY + 25);", "ctx.fillText('RGB GPIO38', g.x + g.width / 2, topY + 25);")
    .replace(
      "ctx.fillStyle = pin.role === 'power' ? '#ef4444' : pin.role === 'ground' ? '#6b7280' : pin.inputOnly ? '#64748b' : '#1f2937';",
      "ctx.fillStyle = pin.role === 'power' ? '#ef4444' : pin.role === 'ground' ? '#6b7280' : (pin.reserved || pin.inputOnly) ? '#94a3b8' : '#1f2937';",
    );
}

// The one control on the board's face: a pill at the bottom with a status
// light, what the state means in words, and the gear that opens the
// device dialog (styled by client/styles.css's .esp-status rules). Runs
// every frame like any `html` prop, so it only builds its DOM once and
// then updates text and tone. `connectionState` values come from the
// dialog script and serialReconnect.js.
const STATUS_HTML = `
container.style.position = 'absolute';
let pill = container.querySelector('.esp-status');
if (!pill) {
  container.replaceChildren();
  pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'esp-status';
  pill.setAttribute('aria-label', 'Connection settings');
  pill.innerHTML = '<span class="esp-status-dot"></span><span class="esp-status-text"></span>'
    + '<svg class="esp-status-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="3"></circle>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>'
    + '</svg>';
  pill.addEventListener('click', helpers.openDialog);
  container.appendChild(pill);
}
const state = String(block.props.find((p) => p.name === 'connectionState')?.value || 'disconnected');
let tone = 'off';
let text = 'Not connected';
let hint = 'Connect over USB';
if (state === 'connecting') {
  tone = 'wait';
  text = 'Connecting\\u2026';
  hint = 'Opening the serial port';
} else if (state === 'connected:running') {
  // What this board would send against what the device holds (see
  // devkitCircuit.isDevkitDirty) -- read from the device on connect.
  const dirty = helpers.devkit.dirty ? helpers.devkit.dirty() : false;
  tone = dirty ? 'warn' : 'on';
  text = dirty ? 'Running \\u00b7 circuit not saved' : 'Logic Module running';
  hint = dirty ? 'Save the circuit to the device' : 'Connected';
} else if (state.startsWith('connected:needs-firmware:')) {
  tone = 'warn';
  text = state.slice('connected:needs-firmware:'.length) + ' \\u00b7 needs firmware';
  hint = 'Install the Logic Module firmware';
} else if (state.startsWith('connected')) {
  tone = 'warn';
  text = 'Connected \\u00b7 no firmware answer';
  hint = 'The board did not answer ping';
}
pill.dataset.tone = tone;
pill.querySelector('.esp-status-text').textContent = text;
pill.style.setProperty('--esp-scale', String(helpers.contentScale || 1));
pill.title = hint + ' \\u2014 connection settings';
`.trim();

const module_ = JSON.parse(fs.readFileSync(MODULE_PATH, 'utf8'));
const block = Object.values(module_.block.blocks)[0];
const { pins, ports, logicalPorts, geometry } = build();

block.ports = ports;
block.logicalPorts = logicalPorts;
block.geometry = { ...block.geometry, ...geometry };

function setProp(name, value) {
  const existing = (block.props || []).find((p) => p.name === name);
  if (existing) existing.value = value;
  else block.props.push({ id: `prp_esp32s3_${name.toLowerCase()}`, name, kind: 'value', value });
}

setProp('pinMap', JSON.stringify(pins));
setProp('render', renderSource('esp32-S3'));
setProp('html', STATUS_HTML);
const currentDialog = (block.props || []).find((p) => p.name === 'dialog')?.value || '';
setProp('dialog', currentDialog
  // The dialog's own Disconnect is the one deliberate "stop offering this
  // port on the next load" (see serialFlash.disconnect's `forget`).
  .replace("    await helpers.serial.disconnect();\n    statusEl.textContent = 'Disconnected.';", "    await helpers.serial.disconnect(true);\n    statusEl.textContent = 'Disconnected.';")
  .replace("programLabel.textContent = 'DIGITAL I/O';", "programLabel.textContent = 'CIRCUIT';")
  .replace(
    "    const childCount = block.children ? block.children.blocks.size : 0;",
    "    let compiledCount = 0;\n    try {\n      const compiled = helpers.console.buildDevkitDesign ? helpers.console.buildDevkitDesign() : { blocks: [] };\n      compiledCount = compiled.blocks.length;\n    } catch (_) {\n      compiledCount = 0;\n    }",
  )
  .replace("    const dirty = childCount && childSnapshot() !== lastSent;", "    const dirty = compiledCount > 0 && childSnapshot() !== lastSent;")
  .replace("    programStatus.textContent = !childCount", "    programStatus.textContent = !compiledCount")
  .replace(
    "      ? 'No Digital I/O blocks inside this ' + (block.name || 'ESP32 DevKit') + ' yet -- enter it to add some.'",
    "      ? 'No supported circuit is connected to this ' + (block.name || 'ESP32') + ' yet.'",
  )
  .replace("    sendBtn.disabled = !childCount;", "    sendBtn.disabled = !compiledCount;")
  .replace(
    "log('Nothing to send -- wire a Timer/Bool to a GPIO pin on this ESP32 DevKit first.');",
    "log('Nothing to send -- connect a supported circuit signal directly to DI, DO, CAN In, or CAN Out.');",
  )
  .replace(
    "log('Nothing to send -- add a Digital I/O block inside this ESP32 DevKit with a real pin set first.');",
    "log('Nothing to send -- connect a supported circuit signal directly to DI, DO, CAN In, or CAN Out.');",
  ));
module_.displayName = block.name = 'esp32-S3';
module_.version = '1.8.0';
setProp('boardVariant', 'ESP32-S3-POE-ETH-8DI-8DO');
setProp('firmwarePreset', 'logic-esp32-s3-waveshare');
setProp('canPins', JSON.stringify({ tx: 2, rx: 3 }));
setProp('usbOrientation', 'top');
setProp('onboardControls', JSON.stringify({
  buttons: [
    { label: 'GPIO0', gpio: 0, role: 'input' },
    // Pulls EN low; it is not a GPIO and nothing can be wired to it.
    { label: 'RESET', gpio: null, role: 'reset' },
  ],
  led: { label: 'RGB', gpio: 38, role: 'output', type: 'addressable' },
}));

module_.description = 'Waveshare ESP32-S3-POE-ETH-8DI-8DO: DI1-DI8, DO1-D8, direct CAN In/Out with configurable speed, and USB firmware installation.';
block.description = '';

fs.writeFileSync(MODULE_PATH, `${JSON.stringify(module_, null, 2)}\n`);

const reserved = pins.filter((p) => p.reserved).map((p) => p.label);
console.log(`esp32-s3-devkit: ${pins.length} pins (${LEFT.length} left, ${RIGHT.length} right, 1 top), ${ports.length} ports`);
console.log(`  block ${geometry.width}x${geometry.height}, reserved: ${reserved.join(', ') || 'none'}`);
