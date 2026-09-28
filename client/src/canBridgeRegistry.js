// Who is reachable through whom on the CAN bus — the plain data behind
// canBridge.js, kept import-free so tools/can-bridge.test.mjs runs it as
// it is. Keyed by node id (the eight hex digits every module firmware
// gives itself); a bridge is the block id of the board that heard the
// node `via can` in its `nodes` reply (see moduleDiscovery.parseNodesOutput).

// A node not heard for this long has left the bus: the boards forget a
// neighbour on the same scale (they print "seen Ns ago"; hellos come
// every 2 s), and a stale bridge would send lines into nothing.
export const STALE_MS = 35000;

const heardVia = new Map(); // nodeId -> { bridgeBlockId, at }

export function noteNodes(bridgeBlockId, nodes, now = Date.now()) {
  for (const node of nodes || []) {
    if (node.self || node.via !== 'can' || !node.id) continue;
    heardVia.set(node.id, { bridgeBlockId, at: now });
  }
}

export function forgetBridge(bridgeBlockId) {
  for (const [nodeId, entry] of heardVia) if (entry.bridgeBlockId === bridgeBlockId) heardVia.delete(nodeId);
}

export function bridgeForNode(nodeId, now = Date.now()) {
  const entry = nodeId ? heardVia.get(nodeId) : null;
  if (!entry) return null;
  if (now - entry.at > STALE_MS) {
    heardVia.delete(nodeId);
    return null;
  }
  return entry.bridgeBlockId;
}

export function nodesBehind(bridgeBlockId, now = Date.now()) {
  const out = [];
  for (const [nodeId, entry] of heardVia) {
    if (entry.bridgeBlockId === bridgeBlockId && now - entry.at <= STALE_MS) out.push(nodeId);
  }
  return out;
}

export function resetRegistry() {
  heardVia.clear();
}
