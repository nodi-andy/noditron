#!/usr/bin/env node
// Builds modules/esp32-s3-devkit/noditron.module.json's board pins.
//
//   node tools/build-esp32-s3-module.mjs
//
// The S3 module shipped as a blank board: a block with a flashing dialog
// and no pins at all, so nothing could be wired to it. This fills in the
// half that makes it a board — the pin map, the ports those pins are, and
// the canvas drawing — leaving the module's own connect/flash props
// alone.
//
// Two sources, both checked into the sibling repositories:
//
//  - The pin-out is the ESP32-S3-DevKitC-1's own, held below as the board
//    reads with its USB sockets at the top (see USB_TOP_NOTE).
//  - Which of those pins the firmware will actually let a circuit use
//    comes from conucon's Logic Module — `gpioUsable()` in
//    modules/esp32_logic/src/main.cpp — so the board on the canvas cannot
//    offer a pin the board in your hand would hard-fault on.
//
// Re-runnable: it rewrites only the props it owns, so the file can be
// regenerated after the module is edited elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(here, '..', 'modules', 'esp32-s3-devkit', 'noditron.module.json');
const CLASSIC_PATH = path.join(here, '..', 'modules', 'esp32-devkit', 'noditron.module.json');

// The board drawn with its two USB-C sockets at the top, which is how
// noditron draws every board (`usbOrientation: top`, and the classic
// DevKit module's own pin map). Espressif's data sheet draws the S3
// DevKitC-1 the other way up, so these two columns are that diagram
// turned through 180°: the left column here is its right column read
// bottom-to-top, and vice versa. Worth re-deriving rather than trusting
// if a pin ever looks wrong.
const USB_TOP_NOTE = 'ESP32-S3-DevKitC-1, USB sockets at the top';

// label, gpio (null for a rail), role
const LEFT = [
  ['GND', null, 'ground'],
  ['G19', 19, 'gpio'],
  ['G20', 20, 'gpio'],
  ['G21', 21, 'gpio'],
  ['G47', 47, 'gpio'],
  ['G48', 48, 'gpio'],
  ['G45', 45, 'gpio'],
  ['G0', 0, 'gpio'],
  ['G35', 35, 'gpio'],
  ['G36', 36, 'gpio'],
  ['G37', 37, 'gpio'],
  ['G38', 38, 'gpio'],
  ['G39', 39, 'gpio'],
  ['G40', 40, 'gpio'],
  ['G41', 41, 'gpio'],
  ['G42', 42, 'gpio'],
  ['G2', 2, 'gpio'],
  ['G1', 1, 'gpio'],
  ['RX0', 44, 'uart'],
  ['TX0', 43, 'uart'],
  ['GND', null, 'ground'],
  ['GND', null, 'ground'],
];

const RIGHT = [
  ['GND', null, 'ground'],
  ['5V', null, 'power'],
  ['G14', 14, 'gpio'],
  ['G13', 13, 'gpio'],
  ['G12', 12, 'gpio'],
  ['G11', 11, 'gpio'],
  ['G10', 10, 'gpio'],
  ['G9', 9, 'gpio'],
  ['G46', 46, 'gpio'],
  ['G3', 3, 'gpio'],
  ['G8', 8, 'gpio'],
  ['G18', 18, 'gpio'],
  ['G17', 17, 'gpio'],
  ['G16', 16, 'gpio'],
  ['G15', 15, 'gpio'],
  ['G7', 7, 'gpio'],
  ['G6', 6, 'gpio'],
  ['G5', 5, 'gpio'],
  ['G4', 4, 'gpio'],
  ['RST', null, 'enable'],
  ['3V3', null, 'power'],
  ['3V3', null, 'power'],
];

// conucon's Logic Module refuses to configure these on an S3 (see
// gpioUsable()), so the board must not offer them as ordinary pins: the
// pin is on the header, but a circuit that drives it would either break
// the USB port or fault the chip. Each carries the reason, which the
// Inspector shows on the port and the drawing greys out.
const RESERVED = new Map([
  [19, 'native USB D− — reconfiguring it breaks the USB port'],
  [20, 'native USB D+ — reconfiguring it breaks the USB port'],
]);

// What a pin is for, beyond "a GPIO" — shown in the Inspector under the
// port, and the reason several of these are worth calling out at all.
const NOTES = new Map([
  [0, 'strapping pin, and the BOOT button'],
  [3, 'strapping pin (JTAG source select)'],
  [8, 'I2C SDA, as the Logic Module configures it on an S3'],
  [9, 'I2C SCL, as the Logic Module configures it on an S3'],
  [15, 'CAN TX by default (see the CAN block)'],
  [16, 'CAN RX by default (see the CAN block)'],
  [43, 'UART0 TX — the USB-UART console'],
  [44, 'UART0 RX — the USB-UART console'],
  [45, 'strapping pin (VDD_SPI voltage)'],
  [46, 'strapping pin, input-only on some S3 revisions'],
  [48, 'the on-board RGB LED'],
]);

const PIN_SPACING = 40;
const FIRST_PIN_OFFSET = 30;

function pinEntry([label, gpio, role], side, row) {
  return {
    label,
    gpio,
    role,
    // The S3 has no input-only pins at all, unlike the classic ESP32's
    // 34/35/36/39 — every GPIO it brings out can drive as well as read.
    inputOnly: gpio === null ? null : false,
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
      direction: null,
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

// The canvas drawing, taken from the classic board's and given this
// board's own furniture: the S3 DevKitC-1 has BOOT and RESET either side
// of the USB sockets and one addressable RGB LED on GPIO48, where the
// classic has two buttons and a plain LED on GPIO2. A pin the firmware
// reserves is drawn muted, the same weight the classic gives an
// input-only pin, so "there but not yours" reads at a glance.
function renderSource(boardName) {
  const classic = JSON.parse(fs.readFileSync(CLASSIC_PATH, 'utf8'));
  const source = Object.values(classic.block.blocks)[0].props.find((p) => p.name === 'render').value;
  return source
    .replace("block.name || 'ESP32 DevKit'", `block.name || '${boardName}'`)
    .replace(
      "drawBoardButton(g.x + g.width / 2 + 72, 'GPIO35', '#f8fafc');",
      "drawBoardButton(g.x + g.width / 2 + 72, 'RESET', '#f8fafc');",
    )
    .replace("ctx.fillText('LED GPIO2', g.x + g.width / 2, topY + 25);", "ctx.fillText('RGB GPIO48', g.x + g.width / 2, topY + 25);")
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
setProp('render', renderSource('ESP32-S3 DevKit'));
setProp('boardVariant', 'ESP32-S3-DevKitC-1');
setProp('usbOrientation', 'top');
setProp('onboardControls', JSON.stringify({
  buttons: [
    { label: 'GPIO0', gpio: 0, role: 'input' },
    // Pulls EN low; it is not a GPIO and nothing can be wired to it.
    { label: 'RESET', gpio: null, role: 'reset' },
  ],
  led: { label: 'RGB', gpio: 48, role: 'output', type: 'addressable' },
}));

module_.description =
  'An ESP32-S3-DevKitC-1 with every header pin on the block edge, USB at the top, and the pins '
  + "conucon's Logic Module reserves on an S3 (native USB, and everything not brought out) marked as such. "
  + 'Connect over Web Serial, detect the chip, and flash the ESP32-S3 build of logicMod from the browser.';

fs.writeFileSync(MODULE_PATH, `${JSON.stringify(module_, null, 2)}\n`);

const reserved = pins.filter((p) => p.reserved).map((p) => p.label);
console.log(`esp32-s3-devkit: ${pins.length} pins (${LEFT.length} left, ${RIGHT.length} right, 1 top), ${ports.length} ports`);
console.log(`  block ${geometry.width}x${geometry.height}, reserved: ${reserved.join(', ') || 'none'}`);
