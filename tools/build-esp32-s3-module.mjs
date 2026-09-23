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

// Reuse the board drawing with this PCB's name, reset button and RGB pin.
function renderSource(boardName) {
  const classic = JSON.parse(fs.readFileSync(CLASSIC_PATH, 'utf8'));
  const source = Object.values(classic.block.blocks)[0].props.find((p) => p.name === 'render').value;
  return source
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
module_.displayName = block.name = 'esp32-S3';
module_.version = '1.7.0';
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
