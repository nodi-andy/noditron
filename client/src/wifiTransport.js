// A board reached over WiFi, shown to serialConsole.js as the same pair of
// byte streams a Web Serial port gives it — so ping, pins, nodes, the
// shell and the live pin events all work unchanged over the air.
//
// The board's WebSocket (port 81) speaks JSON, and its shell answers a
// {"type":"shell","line"} message with exactly what the USB console would
// have printed, `ok` line included (see esp32_logic's runShellLine). So
// every line the console writes becomes one shell message, and every
// shell reply is fed back as console text. The board's own broadcasts are
// translated to the lines the console already knows: an `io` snapshot
// becomes the `io-change` line the serial link sends, a `console` line is
// what a circuit's serial block printed to USB, a CAN frame is `[CAN] rx`.
// What cannot go this way is the raw byte phase of `save-design`; the
// console sends a design over HTTP instead (see serialConsole.js).
const CONSOLE_PORT = 81;

// A CNC module's socket carries grbl's output as plain text frames (its
// WebUI protocol), with a little housekeeping of its own that is not
// console text. Returns the frame's text for the console, or null.
export function rawFrameText(frame) {
  if (typeof frame !== 'string' || !frame.length) return null;
  if (/^(CURRENT_ID|ACTIVE_ID|PING|currentID|activeID):/.test(frame)) return null;
  return frame;
}

// What one message from the board means on the console, or null for
// messages the console has no use for. Pure, so it can be tested.
export function consoleTextFor(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.type === 'shell') return String(message.output ?? '');
  if (message.type === 'io' && Array.isArray(message.pins)) return JSON.stringify({ type: 'io-change', pins: message.pins });
  if (message.type === 'console' && typeof message.line === 'string') return message.line;
  if (message.type === 'can_in' && message.value !== undefined) return `[CAN] rx ${message.value}`;
  return null;
}

// Cuts what the console wrote into whole lines for the shell, keeping an
// unfinished tail for the next write. Empty lines carry nothing.
export function takeLines(pending, chunkText) {
  let buffer = pending + chunkText;
  const lines = [];
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).replace(/\r$/, '').trim();
    buffer = buffer.slice(i + 1);
    if (line) lines.push(line);
  }
  return { lines, pending: buffer };
}

// Every open link, so a page going away can close them with a proper
// close frame: a socket that just vanishes is kept by the board until its
// heartbeat gives up, and its output blocks on the dead socket meanwhile.
const openLinks = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const ws of openLinks) {
      try {
        ws.close(1000, 'page closed');
      } catch {
        // Already gone.
      }
    }
  });
}

export function openWifiDevice(host) {
  const ws = new WebSocket(`ws://${host}:${CONSOLE_PORT}/`);
  openLinks.add(ws);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // The console cancels its reader when a command sequence ends and takes
  // a fresh reader afterwards, exactly as it does with a serial port whose
  // readable is replaced; a cancelled stream is replaced here the same
  // way, and anything that arrived in between waits in the backlog.
  let stream = null;
  let controller = null;
  const backlog = [];
  function freshStream() {
    stream = new ReadableStream({
      start(c) {
        controller = c;
        while (backlog.length) c.enqueue(backlog.shift());
      },
      cancel() {
        stream = null;
        controller = null;
      },
    });
    return stream;
  }
  // `exact` keeps the bytes as they came: a raw grbl frame may end in the
  // middle of a line that the next frame completes.
  function push(text, exact = false) {
    const bytes = encoder.encode(exact || text.endsWith('\n') ? text : `${text}\n`);
    if (controller) {
      try {
        controller.enqueue(bytes);
        return;
      } catch {
        // The stream was closed under us; keep the bytes for the next one.
      }
    }
    backlog.push(bytes);
  }

  function send(line) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error(`the WiFi link to ${host} is closed`);
    ws.send(JSON.stringify({ type: 'shell', line }));
  }
  let pending = '';
  const writable = new WritableStream({
    write(chunk) {
      const taken = takeLines(pending, decoder.decode(chunk));
      pending = taken.pending;
      for (const line of taken.lines) send(line);
    },
  });

  // A CNC module's WebUI socket sends grbl's output as binary frames; the
  // Logic Module speaks JSON text. Binary frames are console bytes as they
  // are, delivered in order because they arrive as ArrayBuffers here.
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      const raw = rawFrameText(decoder.decode(event.data));
      if (raw) push(raw, true);
      return;
    }
    let message = null;
    if (event.data.startsWith('{')) {
      try {
        message = JSON.parse(event.data);
      } catch {
        message = null;
      }
    }
    if (message) {
      const text = consoleTextFor(message);
      if (text) push(text);
      return;
    }
    const raw = rawFrameText(event.data);
    if (raw) push(raw, true);
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`could not reach ${host} (WebSocket port ${CONSOLE_PORT})`));
  });
  ws.onclose = () => {
    openLinks.delete(ws);
    if (controller) {
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    }
    controller = null;
    stream = null;
  };

  const device = {
    get readable() {
      return stream || freshStream();
    },
    writable,
    wifiHost: host,
  };
  return {
    device,
    ready,
    async disconnect() {
      ws.onclose = null;
      openLinks.delete(ws);
      try {
        ws.close(1000, 'disconnect');
      } catch {
        // Never opened.
      }
    },
  };
}
