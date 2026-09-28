// A board's `socket` port: a channel of the board's shell, as a wire.
// Every board module (the esp32-S3 Logic Module, the CNC module) carries
// one logical port named `socket`. The board announces its socket's
// traffic to everyone on its shell — `socket out: <text>` for what its
// circuit put in, `socket in: <text>` for what reached it — and the
// port's direction says which way the wire runs:
//
//   out  — every `socket out:` announcement leaves through the port, and
//          the latest text is the port's value, so an ordinary block
//          (Data, Match) can read it.
//   in   — a value arriving over a wire from an ordinary block (a Data
//          block's text) is written into the board's socket, as the shell
//          line `socket <text>`, each time it changes.
//
// A socket wired to another board's socket is the boards' own affair: the
// board is told where its socket leads when its design is saved to it
// (see devkitCircuit's socketLinksFor and mapEndpoint's socket branch)
// and delivers the text itself, over whatever link it has to that node.
// The browser does not relay between two boards. Flip the direction in
// the Inspector to turn a sender into a receiver.
//
// No imports on purpose: main.js hands in what this needs (subscribing to
// a board's console lines, sending a shell line, publishing a port value)
// so tools/socket-link.test.mjs can run it as it is.

export const SOCKET_PORT_NAME = 'socket';
const KEEP_LINES = 100;

// Every `socket` port on a block with the direction its logical port has.
export function socketPortsOf(block) {
  const out = [];
  for (const port of block?.ports || []) {
    const logical = (block.logicalPorts || []).find((lp) => lp.id === port.logicalId);
    if (!logical || String(logical.name || '').toLowerCase() !== SOCKET_PORT_NAME) continue;
    out.push({ port, logical, direction: logical.direction || null });
  }
  return out;
}

// What of a console line is this board's own socket output: the text of
// a `<id>@socket><text>` announcement whose sender is the board itself
// (`ownId`, its node id; with no id known, any sender counts) — see
// conucon's socketOut. Older firmware said `socket out: <text>`, and
// before the socket block a circuit's `[USB] value` line was how a socket
// wired to the browser reached it. Anything else gives null.
export const SOCKET_LINE_RE = /^([0-9a-f]{8}|\w+)@socket>(.*)$/;
export function socketLineOf(line, ownId = null) {
  const text = String(line ?? '').replace(/\r$/, '');
  const m = text.match(SOCKET_LINE_RE);
  if (m) return !ownId || m[1] === ownId ? m[2] : null;
  if (text.startsWith('socket out: ')) return text.slice('socket out: '.length);
  if (text.startsWith('[USB] ')) return text.slice('[USB] '.length);
  return null;
}

/**
 * subscribeLines(blockId, ({ line, unsolicited }) => void) -> unsubscribe
 * isLive(block) -> whether lines can be written to this board right now
 * shell(blockId, line) -> Promise (the board's reply; ignored here)
 * publish(blockId, portId, value) -> makes `value` the port's own value
 * wireValue(sourceBlockId, sourcePortId) -> what an ordinary wire carries
 * log(message) -> optional, for a send that failed
 */
export function createSocketLinks({ subscribeLines, isLive, shell, publish, wireValue, log = () => {} }) {
  const streams = new Map(); // blockId -> { seq, latest, lines: [{ seq, text }], unsubscribe }
  const lastSent = new Map(); // `${targetId}:${sourcePortId}` -> last plain value sent
  const queues = new Map(); // targetId -> promise chain, so lines reach a board in order

  function ensureStream(block) {
    const blockId = block.id;
    if (streams.has(blockId)) {
      streams.get(blockId).block = block;
      return streams.get(blockId);
    }
    const stream = { seq: 0, latest: undefined, lines: [], unsubscribe: null, block };
    stream.unsubscribe = subscribeLines(blockId, ({ line, unsolicited }) => {
      if (!unsolicited) return;
      // The board's node id, recorded on the block by its dialog once it
      // has identified — read at each line, since it may arrive later.
      const ownId = (stream.block.props || []).find((p) => p.name === 'nodeId')?.value || null;
      const text = socketLineOf(line, ownId);
      if (text === null) return;
      stream.seq += 1;
      stream.latest = text;
      stream.lines.push({ seq: stream.seq, text });
      if (stream.lines.length > KEEP_LINES) stream.lines.splice(0, stream.lines.length - KEEP_LINES);
    });
    streams.set(blockId, stream);
    return stream;
  }

  function send(target, text) {
    const chain = (queues.get(target.id) || Promise.resolve())
      .then(() => shell(target.id, text))
      .catch((err) => log(`${target.name || target.id}: socket line not sent: ${err?.message || err}`));
    queues.set(target.id, chain);
  }

  function forgetTarget(blockId) {
    for (const key of [...lastSent.keys()]) if (key.startsWith(`${blockId}:`)) lastSent.delete(key);
  }

  return {
    // Once per runtime tick, with every board block and the level it sits
    // on (see devkitCircuit.collectBoardBlocks).
    tick(boards) {
      const byId = new Map(boards.map((entry) => [entry.block.id, entry]));

      // A stream per board that has a socket at all, whether or not it is
      // connected yet: the subscription is by block id, so it is in place
      // the moment the board's console opens. A board that is gone takes
      // its stream with it.
      for (const { block } of boards) if (socketPortsOf(block).length) ensureStream(block);
      for (const [blockId, stream] of streams) {
        if (byId.has(blockId)) continue;
        stream.unsubscribe?.();
        streams.delete(blockId);
        forgetTarget(blockId);
      }

      // out: the latest line is the port's value.
      for (const { block } of boards) {
        for (const socket of socketPortsOf(block)) {
          if (socket.direction !== 'out') continue;
          publish(block.id, socket.port.id, streams.get(block.id)?.latest);
        }
      }

      // in: what the wire brings goes to the shell.
      for (const { block, level } of boards) {
        const ins = socketPortsOf(block).filter((socket) => socket.direction === 'in');
        if (!ins.length) continue;
        if (!isLive(block)) {
          // A value seen while it was away is sent again once it is back.
          forgetTarget(block.id);
          continue;
        }
        const connections = [...(level?.connections?.values?.() || [])];
        for (const socket of ins) {
          for (const conn of connections) {
            if (conn.targetBlockId !== block.id || conn.targetPortId !== socket.port.id) continue;
            // Board to board is the boards' own link (see the module doc);
            // the browser stays out of it.
            if (byId.has(conn.sourceBlockId)) continue;
            // An ordinary value (a Data block's text): into the board's
            // socket when it changes, as the shell line the board announces
            // as `socket in:` and hands to its circuit (or, on the CNC
            // module, to grbl).
            const value = wireValue(conn.sourceBlockId, conn.sourcePortId);
            if (value === undefined || value === null || value === false) continue;
            const text = String(value).trim();
            if (!text) continue;
            const key = `${block.id}:${conn.sourcePortId}`;
            if (lastSent.get(key) === text) continue;
            lastSent.set(key, text);
            send(block, `socket ${text}`);
          }
        }
      }
    },

    dispose() {
      for (const stream of streams.values()) stream.unsubscribe?.();
      streams.clear();
      lastSent.clear();
    },
  };
}
