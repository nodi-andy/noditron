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

const NODE_LINE_RE = /^(logic|cnc|node)\s+([0-9a-f]{8})(?:\s+(\S+))?\s+v(\S+)\s+(self|seen\s+(\d+)s\s+ago\s+via\s+(\S+))\s*$/;

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
export const NODE_TYPE_MODULES = { cnc: 'esp32-cnc', logic: 'esp32-s3-devkit' };

export function moduleNameFor(kind, { nativeUsb = null } = {}) {
  if (kind === 'cnc') return NODE_TYPE_MODULES.cnc;
  if (kind === 'logic') return nativeUsb === false ? 'esp32-devkit' : NODE_TYPE_MODULES.logic;
  return null;
}

// The neighbours worth placing next to a board that was just added: the
// ones heard on the CAN bus, which the board is physically wired to and
// which the canvas therefore shows wired too. A node heard only over WiFi
// has a link of its own to be connected through; it is not drawn as a
// wire from this board.
export function canNeighbours(nodes) {
  return (nodes || []).filter((n) => !n.self && n.via === 'can' && NODE_TYPE_MODULES[n.type]);
}
