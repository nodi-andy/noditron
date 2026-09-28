// The CAN bus, drawn. A running board is asked for its neighbours
// (`nodes`, see moduleDiscovery.js); every node it hears on the bus gets
// the block its type names (a CNC module for a cnc node, an esp32-S3 for
// a logic node), placed beside the board on the board's own level and
// wired to it CAN pin to CAN pin — the bus the boards are physically on,
// on the canvas. The node is noted for the bridge (canBridge.js), so the
// new block is online through the board that hears it: its state pill
// shows running, its shell runs as `node <name> <line>` on the bridge.
//
// Three callers: the Add Block window right after a board is connected
// and placed; the board's own page after it connected to the board it
// came from (boardPage.js); and the bridge poll every POLL_MS
// (canBridge.js's onNodes), so a module that joins the bus later appears
// too — once: a block deleted on purpose is not put back by the next
// poll (the `offered` set), only by a fresh connect.
//
// A neighbour lands on the board's own level whatever level is on screen
// (the level being edited is switched for the paste and switched back in
// the same tick, see onLevel): the board's own page opens inside the
// board, and the poll runs while you work in there — an earlier version
// waited for the board's level to be on screen, and a CNC found at boot
// only appeared some polls after leaving the board. A neighbour that
// already has a block (by node id) is only wired.
import { generateId } from '/nodigraph/src/model/Block.js';
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { createConnection } from '/nodigraph/src/model/Connection.js';
import * as serialConsole from './serialConsole.js';
import { collectBoardBlocks, findContainingLevel } from './devkitCircuit.js';
import { addModuleBlock, resolveModuleByName } from './library.js';
import { parseNodesOutput, canNeighbours, NODE_TYPE_MODULES } from './moduleDiscovery.js';
import { noteNodes, bridgeForNode, refreshBridgedStates } from './canBridge.js';

const CAN_PORT_NAME = 'can';
// A CAN neighbour lands to the right of the board it was heard from.
export const NEIGHBOUR_GAP = 140;

function propOf(block, name) {
  return (block?.props || []).find((p) => p.name === name)?.value;
}

// Sets a prop, adding it when the module's template never declared one —
// the S3 and CNC manifests carry no nodeId/nodeName of their own (their
// dialogs' setProp silently skips a missing prop), and the node id is what
// a socket wire and the next `nodes` scan find a board by.
export function setBlockProp(block, name, value) {
  let prop = block.props.find((p) => p.name === name);
  if (!prop) {
    prop = { id: generateId('prp'), name, kind: 'value', value };
    block.props.push(prop);
  } else {
    prop.value = value;
  }
  block.description = serializeBlockDescription(block);
}

// { block, level } of the board block carrying `nodeId`, or null.
export function findBoardByNodeId(nodigraph, nodeId) {
  if (!nodeId) return null;
  return collectBoardBlocks(nodigraph.project.rootBlock.children).find(({ block }) => propOf(block, 'nodeId') === nodeId) || null;
}

export function canPortOf(block) {
  for (const port of block.ports || []) {
    const logical = (block.logicalPorts || []).find((lp) => lp.id === port.logicalId);
    if (logical && String(logical.name || '').toLowerCase() === CAN_PORT_NAME) return port;
  }
  return null;
}

// The bus between two boards as a wire, CAN pin to CAN pin. Nothing to do
// when either has no CAN pin (the classic DevKit), or the wire is there.
export function wireCan(nodigraph, a, b) {
  const pa = canPortOf(a);
  const pb = canPortOf(b);
  if (!pa || !pb) return false;
  if (nodigraph.project.hasConnection(pa.id, pb.id) || nodigraph.project.hasConnection(pb.id, pa.id)) return true;
  const added = nodigraph.project.addConnection(createConnection({ sourceBlockId: a.id, sourcePortId: pa.id, targetBlockId: b.id, targetPortId: pb.id }));
  return Boolean(added);
}

// The ids of the containers from the root down to `level`, [] for the
// root itself, null when `level` is not in the tree.
export function pathToLevel(root, level, path = []) {
  if (root === level) return path;
  for (const block of root?.blocks?.values?.() || []) {
    if (!block.children) continue;
    const found = pathToLevel(block.children, level, [...path, block.id]);
    if (found) return found;
  }
  return null;
}

// Runs `fn` with the level being edited switched to `levelPath` and put
// back afterwards — synchronously, so no frame is drawn in between. What
// nodigraph adds, pastes or wires goes into the level being edited (see
// library.addModuleBlock, Project.addConnection), and a neighbour belongs
// beside its board whatever level is on screen: the board's own page
// opens inside the board, and the bridge poll runs while you work in
// there.
function onLevel(nodigraph, levelPath, fn) {
  const project = nodigraph.project;
  const saved = project.path;
  const same = saved.length === levelPath.length && saved.every((id, i) => id === levelPath[i]);
  if (same) return fn(nodigraph);
  project.path = levelPath;
  try {
    // addModuleBlock selects what it added and persists; neither belongs
    // to a level that is not on screen. Persisted once, below.
    return fn({ ...nodigraph, project, selection: { select() {}, clear() {} }, persist() {} });
  } finally {
    project.path = saved;
  }
}

async function resolveModule(nodigraph, name) {
  return resolveModuleByName(nodigraph, name);
}

// Places and wires the CAN neighbours among `nodes` (a parsed `nodes`
// reply) for `board`, into the board's own level. Resolves to
// { neighbours, placed, wired }: the CAN neighbours heard, the names of
// the blocks placed now, the names of the blocks wired to the board
// (placed now or found).
export async function placeNeighbours(nodigraph, board, nodes, { status = () => {}, offered = null, resolve = resolveModule, add = addModuleBlock, refresh = refreshBridgedStates, onBus = bridgeForNode } = {}) {
  // Heard on CAN in this reply — or in a recent one: a board on both the
  // bus and the LAN reports whichever hello came last (see canBridge.js's
  // scan), so a node the registry still has behind this board counts.
  const neighbours = canNeighbours(nodes.map((n) => (n.via !== 'can' && !n.self && onBus(n.id) === board.id ? { ...n, via: 'can' } : n)));
  const placed = [];
  const wired = [];
  if (!neighbours.length) return { neighbours, placed, wired };
  const boardLevel = findContainingLevel(nodigraph.project.rootBlock.children, board.id);
  const levelPath = boardLevel ? pathToLevel(nodigraph.project.rootBlock.children, boardLevel) : null;
  if (!levelPath) return { neighbours, placed, wired };
  let index = 0;
  for (const node of neighbours) {
    let peer = findBoardByNodeId(nodigraph, node.id)?.block || null;
    if (!peer) {
      if (offered?.has(node.id)) continue;
      const moduleName = NODE_TYPE_MODULES[node.type];
      status(`${node.type} ${node.name || node.id} heard on CAN: placing ${moduleName}...`);
      // The manifest first (it may be fetched), then the paste, in one go
      // on the board's level.
      const { manifest, source } = await resolve(nodigraph, moduleName);
      peer = onLevel(nodigraph, levelPath, (ng) => {
        const block = add(ng, manifest, source)[0];
        block.geometry.x = board.geometry.x + board.geometry.width + NEIGHBOUR_GAP;
        block.geometry.y = board.geometry.y + index * (block.geometry.height + 40);
        if (node.name) block.name = node.name;
        setBlockProp(block, 'nodeId', node.id);
        setBlockProp(block, 'nodeName', node.name || '');
        return block;
      });
      placed.push(peer.name || node.id);
      index += 1;
    }
    offered?.add(node.id);
    // Wired on the board's level too — a neighbour found elsewhere in
    // the tree is not (the wire would cross levels).
    const peerLevel = findContainingLevel(nodigraph.project.rootBlock.children, peer.id);
    if (peerLevel === boardLevel && onLevel(nodigraph, levelPath, (ng) => wireCan(ng, board, peer))) wired.push(peer.name || node.id);
  }
  // Heard on the bus behind a running board: online through it, now.
  refresh(nodigraph);
  if (placed.length || wired.length) {
    nodigraph.persist();
    nodigraph.renderLoop.requestRender();
  }
  return { neighbours, placed, wired };
}

// Asks `board` for its nodes, notes them for the bridge and places the CAN
// neighbours. A board that does not answer counts as hearing nothing.
export async function scanAndPlaceNeighbours(nodigraph, board, { status = () => {}, shell = serialConsole.shell, wait = (ms) => new Promise((r) => setTimeout(r, ms)), ...rest } = {}) {
  status('Scanning its bus (nodes)...');
  const ask = async () => parseNodesOutput((await shell(board.id, 'nodes', { timeoutMs: 2500, quiet: true }).catch(() => ({ lines: [] }))).lines || []);
  let nodes = await ask();
  noteNodes(board.id, nodes);
  // A module the board hears on the LAN as well may have been reported
  // `via wifi` just now only because that hello came last (firmware up
  // to 20260927e): ask once more, a hello later, and take the CAN answer
  // of either.
  if (nodes.some((n) => !n.self && n.via !== 'can' && NODE_TYPE_MODULES[n.type])) {
    await wait(1200);
    const again = await ask();
    noteNodes(board.id, again);
    const onCan = new Set(again.filter((n) => n.via === 'can').map((n) => n.id));
    nodes = nodes.map((n) => (onCan.has(n.id) ? { ...n, via: 'can' } : n));
    for (const n of again) if (!nodes.some((m) => m.id === n.id)) nodes.push(n);
  }
  const result = await placeNeighbours(nodigraph, board, nodes, { status, ...rest });
  return { nodes, ...result };
}

// One line about what a scan found, for a status area or a log.
export function describeNeighbours(label, { neighbours, wired }) {
  if (wired.length) return `${label} wired over CAN to ${wired.join(', ')}.`;
  return `${label}${neighbours.length ? '' : ': nothing else heard on its CAN bus'}.`;
}
