// A board serves noditron of itself (boardPage.js), holding its project in
// its own /project.json. So that page shows what this one does, an
// explicit Save here also stores the project on every board it can reach
// over the network — the same diagram, the same view, whichever page opens.
//
// Reached is checked, not assumed: every board's access point is
// 192.168.0.1, so the address a board gives (its `ping`'s IP, or the host
// its WiFi link goes to) may be another board's when this computer is on
// that one's network. The board at the address has to name the same node
// in its /api/version (which answers any origin) before the project is
// sent. The upload itself is the board's /files (the same one the board's
// own page saves through, see boardPage.installProjectStore): it answers no
// other origin, so it goes as no-cors and is not read back.

const DEFAULT_TIMEOUT_MS = 2500;

function usableAddress(ip) {
  const text = String(ip || '').trim();
  return text && text !== '-' && text !== '0.0.0.0' ? text.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
}

async function nodeAt(address, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${address}/api/version`, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json())?.node || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 'sent', 'unreachable' (no address answered as this node) or
// 'no-address'. `addresses` in the order to try.
export async function pushProjectToBoard({ nodeId, addresses, data, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const candidates = [...new Set((addresses || []).map(usableAddress).filter(Boolean))];
  if (!nodeId || !candidates.length) return 'no-address';
  for (const address of candidates) {
    if ((await nodeAt(address, fetchImpl, timeoutMs)) !== nodeId) continue;
    const body = new FormData();
    body.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), 'project.json');
    try {
      await fetchImpl(`http://${address}/files`, { method: 'POST', body, mode: 'no-cors' });
      return 'sent';
    } catch {
      return 'unreachable';
    }
  }
  return 'unreachable';
}

// Every board with a link of its own (a CAN neighbour has no address this
// computer reaches): its WiFi host, then the address its ping names.
export async function pushProjectToBoards({ boards, data, sessionOf, identify, fetchImpl = fetch, log = () => {} }) {
  const results = [];
  for (const board of boards) {
    const nodeId = (board.props || []).find((p) => p.name === 'nodeId')?.value;
    const session = sessionOf(board.id);
    if (!nodeId || !session) continue;
    const addresses = [];
    if (session.kind === 'wifi' && session.host) addresses.push(session.host);
    try {
      const info = await identify(board.id);
      if (info?.ip) addresses.push(info.ip);
    } catch {
      // No ping answer: the WiFi host alone, if there is one.
    }
    const outcome = await pushProjectToBoard({ nodeId, addresses, data, fetchImpl });
    if (outcome === 'sent') log(`${board.name}: its page now holds this diagram.`);
    results.push({ board, outcome });
  }
  return results;
}
