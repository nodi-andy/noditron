// What a board says about itself and its neighbours, turned into which
// module to place for it. Two sources: the `ping` reply identify() already
// parses (its `kind`, logic or cnc), and the `nodes` shell command every
// module firmware answers with one line per node it knows:
//
//   logic a1d148c4 esp32-s3 v1.2 self
//   cnc 0dd04644 CNC v1.4 seen 0s ago via can
//   logic 1b2c3d4e v1.2 seen 3s ago via wifi          (a node with no name)
//
// The first word is the node's type, the second its id; a name follows
// when the node has one. `self` marks the answering board; every other
// line says how it was heard — `can` is the bus the boards are wired to,
// `wifi` the LAN hello. (See conucon's printNodes in esp32_logic/src/main.cpp
// and esp32_cnc/.../Module.cpp — both print this same shape.)
//
// No imports on purpose, so tools/add-block.test.mjs runs this as it is.

// `board=<hardware>` at the end (firmware builds 20260930f/g and later) is
// what the node's heartbeat said about its hardware — see HARDWARE.
const NODE_LINE_RE = /^(logic|cnc|node)\s+([0-9a-f]{8})(?:\s+(\S+))?\s+v(\S+)\s+(self|seen\s+(\d+)s\s+ago\s+via\s+(\S+))(?:\s+board=(\S+))?\s*$/;

export function parseNodesOutput(lines) {
  const nodes = [];
  for (const raw of lines || []) {
    const m = String(raw ?? '').replace(/\r$/, '').match(NODE_LINE_RE);
    if (!m) continue;
    // A node without a name prints its version where the name would be;
    // the regex only takes a name when a version still follows it.
    nodes.push({
      type: m[1],
      id: m[2],
      name: m[3] || '',
      version: m[4],
      self: m[5] === 'self',
      ageS: m[6] === undefined ? null : Number(m[6]),
      via: m[7] || null,
      board: m[8] || null,
    });
  }
  return nodes;
}

// Which bundled module stands for a node type. A logic node is the
// esp32-S3 (the Waveshare board conucon's esp32_logic is built for, the
// one with a CAN pin to be heard over); the classic ESP32 DevKit runs the
// same firmware, so a board on a serial port is told apart by its USB: the
// S3 talks through the chip's own USB (Espressif's vendor id, see
// serialFlash.usesNativeUsb), the classic DevKit through a bridge chip.
// Over WiFi, or heard on the bus, there is nothing to tell them apart by,
// and the S3 is the board that has those links.
// Three boards, two firmwares, six modules named <hardware>-<firmware>:
//   esp32-devkit   the classic ESP32 DevKit V1
//   esp32s3-2io    Waveshare ESP32-S3 RS485/CAN, two isolated IOs
//   esp32s3-8io    Waveshare ESP32-S3-POE-ETH-8DI-8DO
// A board says which it is: `board=<hardware>` on the second [INFO] line
// of its `?` reply (firmware builds 20260930a and later — see
// serialConsole.parseNodeLine), so the module placed for it is the one for
// exactly its hardware and firmware.
export const HARDWARE = ['esp32-devkit', 'esp32s3-2io', 'esp32s3-8io'];
export const FIRMWARES = ['logic', 'cnc'];
export const MODULE_NAMES = HARDWARE.flatMap((hw) => FIRMWARES.map((fw) => `${hw}-${fw}`));
// The names these modules had before the scheme, still recorded in older
// projects and reported by older firmware: resolved to today's module.
export const MODULE_ALIASES = { 'esp32-devkit': 'esp32-devkit-logic', 'esp32-s3-devkit': 'esp32s3-8io-logic', 'esp32-cnc': 'esp32-devkit-cnc' };
export function canonicalModuleName(name) {
  return MODULE_ALIASES[name] || name;
}
// A node heard on the bus says only its type (the heartbeat carries no
// hardware id): the module placed for it is the board each firmware is
// used on around here — the 8DI/8DO board for logic, the RS485/CAN board
// for the CNC.
export const NODE_TYPE_MODULES = { cnc: 'esp32s3-2io-cnc', logic: 'esp32s3-8io-logic' };

export function moduleNameFor(kind, { nativeUsb = null, board = null } = {}) {
  if (!FIRMWARES.includes(kind)) return null;
  // The board named its hardware: exactly that module.
  if (board && HARDWARE.includes(board)) return `${board}-${kind}`;
  // Older firmware: a board on a USB-UART bridge chip is the classic
  // DevKit, native USB is an S3 — the one each firmware is used on.
  if (nativeUsb === false) return `esp32-devkit-${kind}`;
  return NODE_TYPE_MODULES[kind];
}

// The neighbours worth placing next to a board that was just added: the
// ones heard on the CAN bus, which the board is physically wired to and
// which the canvas therefore shows wired too. A node heard only over WiFi
// has a link of its own to be connected through; it is not drawn as a
// wire from this board.
export function canNeighbours(nodes) {
  return (nodes || []).filter((n) => !n.self && n.via === 'can' && NODE_TYPE_MODULES[n.type]);
}
