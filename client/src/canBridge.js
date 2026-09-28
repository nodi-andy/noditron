// A board reached through another board: the CNC module on the CAN bus
// behind the esp32-S3 that is connected over USB or WiFi. Every module
// shell has `node <name> <line>` — run <line> on the node called <name>
// and print its answer (see conucon's esp32_logic main.cpp and esp32_cnc
// Module.cpp, "nodes talking to nodes") — so a board with a link of its
// own is a way to every node it hears. serialConsole.js does the asking
// (its bridged shell sends `node <target> <line>` to the bridge and the
// reply lines are the far board's); this file keeps track of who is
// behind whom.
//
// Every board with a link of its own is asked `nodes` every few seconds;
// each node it hears `via can` is recorded as reachable through it (see
// canBridgeRegistry.js). A placed block whose `nodeId` is such a node, and
// has no link of its own, is online through that bridge: its
// connectionState says so (so its status pill, its dialog and its socket
// wire treat it as running) and serialConsole's shell/identify for it go
// through the bridge, addressed by its node name.
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import * as serialFlash from './serialFlash.js';
import * as serialConsole from './serialConsole.js';
import { collectBoardBlocks, isDevkitRunning } from './devkitCircuit.js';
import { parseNodesOutput } from './moduleDiscovery.js';
import { noteNodes, forgetBridge, bridgeForNode } from './canBridgeRegistry.js';

export { noteNodes, forgetBridge, bridgeForNode } from './canBridgeRegistry.js';

export const POLL_MS = 10000;

const propValue = (block, name) => (block?.props || []).find((p) => p.name === name)?.value;

function boardById(nodigraph, id) {
  return collectBoardBlocks(nodigraph.project.rootBlock.children).find(({ block }) => block.id === id)?.block || null;
}

// How a block is reached through another board: `{ bridgeId, target }`,
// the bridge's block id and the name the far node answers to on the bus
// (its node name, else its id). Null for a block with a link of its own,
// or none behind a running bridge.
export function bridgeForBlock(nodigraph, blockId) {
  if (serialFlash.getSession(blockId)) return null;
  const block = boardById(nodigraph, blockId);
  const nodeId = propValue(block, 'nodeId');
  const bridgeId = bridgeForNode(nodeId);
  if (!bridgeId) return null;
  const bridge = boardById(nodigraph, bridgeId);
  if (!bridge || !serialFlash.getSession(bridgeId) || !isDevkitRunning(bridge)) return null;
  return { bridgeId, target: propValue(block, 'nodeName') || nodeId };
}

// connectionState of every block without a link of its own follows
// whether a bridge reaches it: running while one does, disconnected when
// it stops — only for blocks this file put online, never one whose state
// came from its own link (serialReconnect.js owns those).
const bridged = new Set();

export function refreshBridgedStates(nodigraph) {
  let changed = false;
  for (const { block } of collectBoardBlocks(nodigraph.project.rootBlock.children)) {
    if (serialFlash.getSession(block.id)) { bridged.delete(block.id); continue; }
    const online = Boolean(bridgeForBlock(nodigraph, block.id));
    const prop = (block.props || []).find((p) => p.name === 'connectionState');
    if (!prop) continue;
    if (online) {
      bridged.add(block.id);
      if (prop.value !== 'connected:running') {
        prop.value = 'connected:running';
        block.description = serializeBlockDescription(block);
        changed = true;
      }
    } else if (bridged.has(block.id)) {
      bridged.delete(block.id);
      if (prop.value !== 'disconnected') {
        prop.value = 'disconnected';
        block.description = serializeBlockDescription(block);
        changed = true;
      }
    }
  }
  if (changed) {
    nodigraph.persist();
    nodigraph.renderLoop.requestRender();
  }
  return changed;
}

// Asks every board with a live link of its own who it hears, then settles
// every block's state. Called from the Add Block window after a board is
// placed, and by the poll below.
// `onNodes(board, nodes)` hears every answer, after it is noted: the
// caller that places blocks for new neighbours (canNeighbours.js, wired
// in main.js) lives there, not here — this file only knows who is behind
// whom.
export async function scanBridges(nodigraph, { onNodes = null } = {}) {
  const boards = collectBoardBlocks(nodigraph.project.rootBlock.children)
    .filter(({ block }) => serialFlash.getSession(block.id) && isDevkitRunning(block));
  const heard = [];
  await Promise.all(boards.map(async ({ block }) => {
    try {
      const reply = await serialConsole.shell(block.id, 'nodes', { timeoutMs: 2500, quiet: true });
      const nodes = parseNodesOutput(reply.lines || []);
      if (reply.ok || nodes.length) {
        // Not forgotten first: a board on both the bus and the LAN says
        // `via can` or `via wifi` for the same node depending on which
        // hello came last (firmware builds up to 20260927e overwrite it
        // each time), so a scan that reads wifi must not drop a node the
        // last one heard on CAN. A node that really left the bus ages out
        // (canBridgeRegistry.STALE_MS).
        noteNodes(block.id, nodes);
        heard.push({ block, nodes });
      }
    } catch {
      // A board that did not answer keeps what it said last time, until
      // that goes stale (see canBridgeRegistry.STALE_MS).
    }
  }));
  refreshBridgedStates(nodigraph);
  if (onNodes) {
    for (const { block, nodes } of heard) {
      try {
        await onNodes(block, nodes);
      } catch (err) {
        console.warn(`[noditron] ${block.name}: its CAN neighbours could not be placed:`, err.message);
      }
    }
  }
}

export function installCanBridge(nodigraph, { onNodes = null } = {}) {
  serialConsole.setBridgeResolver((blockId) => bridgeForBlock(nodigraph, blockId));
  let nextScan = 0;
  let scanning = false;
  // Once per POLL_MS from the runtime tick; a scan still running is not
  // started twice.
  async function tick(now = Date.now()) {
    if (scanning || now < nextScan) return;
    scanning = true;
    nextScan = now + POLL_MS;
    try {
      await scanBridges(nodigraph, { onNodes });
    } finally {
      scanning = false;
    }
  }
  return { tick, scan: () => scanBridges(nodigraph, { onNodes }) };
}
