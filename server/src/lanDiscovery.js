// Boards on the local network, for the Add Block window's Connect IP (see
// client/src/addBlockDialog.js): two ways of finding them, merged.
//
// Passive: every module firmware broadcasts a JSON "hello" on UDP 47474
// every 2 s (conucon's udpHelloSend in esp32_logic/src/main.cpp and
// esp32_cnc/.../Module.cpp — {"hello":1,"id","type","name","version","ip",...}).
// Listening on that port costs nothing and hears a board the moment it is
// on the network. A firewall that drops broadcasts to node, or a board on
// another subnet, is never heard this way, so there is also
//
// Active: a sweep of the /24 around each of this machine's own private
// IPv4 addresses, asking every host for GET /api/version with a short
// timeout — the endpoint both firmwares answer with their node id, type,
// name and build. A few seconds for a full subnet.
//
// The browser cannot do either itself: no raw sockets, and a fetch to
// hundreds of addresses is slow and blocked by private-network rules.
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';

export const HELLO_PORT = 47474;
export const HEARD_TTL_MS = 30000;
const heard = new Map(); // id -> board

// One hello, as the board record it stands for; null for anything else
// on the port. `from` is the packet's source address, the truth about
// where the board is reachable even when its own `ip` field says its
// access-point address.
export function parseHello(text, from, now = Date.now()) {
  let json;
  try {
    json = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!json || json.hello !== 1 || typeof json.id !== 'string' || !/^[0-9a-f]{8}$/.test(json.id)) return null;
  return {
    id: json.id,
    type: String(json.type || 'node'),
    name: String(json.name || ''),
    version: String(json.version || ''),
    ip: from || String(json.ip || ''),
    reportedIp: String(json.ip || ''),
    state: json.state || json.circuit || null,
    lastSeen: now,
    via: 'hello',
  };
}

export function startHelloListener(log = console) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    const board = parseHello(msg.toString('utf8'), rinfo.address);
    if (board) heard.set(board.id, board);
  });
  sock.on('error', (err) => {
    log.warn(`LAN hello listener off (UDP ${HELLO_PORT}): ${err.message}`);
    try { sock.close(); } catch { /* already closed */ }
  });
  sock.bind(HELLO_PORT, () => {
    try { sock.setBroadcast(true); } catch { /* not needed to receive */ }
    log.log(`Listening for board hellos on UDP ${HELLO_PORT}`);
  });
  return sock;
}

export function heardBoards(now = Date.now()) {
  const out = [];
  for (const [id, board] of heard) {
    if (now - board.lastSeen > HEARD_TTL_MS) { heard.delete(id); continue; }
    out.push({ ...board, ageMs: now - board.lastSeen });
  }
  return out;
}

const PRIVATE_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// The /24 around each private IPv4 address this machine has — a wider
// mask is still swept as one /24 (the boards' own hello reaches exactly
// their subnet; a bigger network is a manual address). `interfaces` has
// os.networkInterfaces()' shape.
export function subnetsOf(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || !PRIVATE_RE.test(a.address)) continue;
      const base = a.address.split('.').slice(0, 3).join('.');
      if (out.some((s) => s.base === base)) continue;
      out.push({ base, self: a.address, interface: name });
    }
  }
  return out;
}

// GET /api/version from one host: the board record, or null when nothing
// there answers as a board within the timeout.
export function probeVersion(ip, timeoutMs = 700) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const req = http.get({ host: ip, port: 80, path: '/api/version', timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json && typeof json.node === 'string' && json.type) {
            finish({ id: json.node, type: String(json.type), name: String(json.name || ''), version: String(json.version || ''), build: String(json.build || ''), ip, via: 'scan', lastSeen: Date.now() });
            return;
          }
        } catch { /* not a board */ }
        finish(null);
      });
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(null));
  });
}

export async function sweepSubnets({ subnets = subnetsOf(), timeoutMs = 700, concurrency = 64, probe = probeVersion } = {}) {
  const targets = [];
  for (const { base, self } of subnets) {
    for (let i = 1; i <= 254; i += 1) {
      const ip = `${base}.${i}`;
      if (ip !== self) targets.push(ip);
    }
  }
  const found = [];
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const ip = targets[next++];
      const board = await probe(ip, timeoutMs);
      if (board) found.push(board);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return found;
}

// One list, by node id: a sweep result carries the build and answers
// from the address it was asked at, so it wins over a hello for the same
// board; a hello-only board keeps what its hello said.
export function mergeBoards(heardList, sweptList) {
  const byId = new Map();
  for (const b of heardList) byId.set(b.id, b);
  for (const b of sweptList) byId.set(b.id, { ...(byId.get(b.id) || {}), ...b, via: byId.has(b.id) ? 'hello+scan' : 'scan' });
  return [...byId.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

export async function discover({ scan = false } = {}) {
  const subnets = subnetsOf();
  const swept = scan ? await sweepSubnets({ subnets }) : [];
  return { boards: mergeBoards(heardBoards(), swept), subnets: subnets.map((s) => `${s.base}.0/24`), scanned: scan };
}
