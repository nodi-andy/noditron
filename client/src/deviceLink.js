// HTTP link to a booted ESP32 running conucon's esp32_logic firmware, over
// its own WiFi AP (SSID "LOGICMOD", default IP 192.168.0.1) — a completely
// different connection than serialFlash.js's Web Serial link to the ROM
// bootloader (that one only exists to flash; this one only exists once
// real firmware is already running). See conucon's modules/esp32_logic/
// src/main.cpp: GET /design.json reads the current circuit and doubles as
// an identify check (only logicMod serves that path), POST /save-design
// (multipart) pushes a new one — the firmware reloads it automatically
// ~500ms after a successful save, no separate reload command needed.
//
// Two real prerequisites this can't paper over:
//  - this computer's own WiFi has to actually be joined to the board's AP
//    first — a physically separate, internet-less network from wherever
//    noditron itself is loaded from; switching networks doesn't unload an
//    already-open tab, so load noditron first, then switch.
//  - the firmware has to be a build that sends Access-Control-Allow-Origin
//    (added to serveJsonFile/handleSaveDesignDone in conucon's main.cpp) —
//    an older build has no CORS header at all, and the browser blocks
//    reading the response before any code here ever sees it, regardless of
//    what actually happened on the wire.
const DEVICE_BASE = 'http://192.168.0.1';
const TIMEOUT_MS = 4000;

function timeoutMessage(err) {
  return err.name === 'AbortError'
    ? "Timed out — is this computer's WiFi connected to the board's own network (LOGICMOD)?"
    : err.message;
}

export async function identify() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${DEVICE_BASE}/design.json`, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const design = await res.json().catch(() => null);
    return Array.isArray(design?.blocks) ? { reachable: true, verified: true, design } : { reachable: true, verified: false };
  } catch (err) {
    return { reachable: false, error: timeoutMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Deliberately not a general graph compiler — esp32_logic's own circuit
// model is belts on a grid (Factorio-style signal routing), nodigraph's is
// named ports and point-to-point wires between arbitrary blocks; actually
// translating connections between the two is real, separate work (see
// this module's own doc and the conversation that scoped it down). All
// this does is declare the pins themselves: one din/dout per Digital I/O
// child that has a real pin set, laid out on an unconnected row. A design
// with wiring still needs to be finished by hand in conucon's own GUI for
// now.
export function buildMinimalDesign(childBlocks) {
  const blocks = [];
  let nextBlockId = 1;
  let col = 0;
  for (const child of childBlocks) {
    if ((child.props || []).find((p) => p.name === 'noditronKind')?.value !== 'digital-io') continue;
    const pin = (child.props || []).find((p) => p.name === 'pin')?.value;
    if (pin === null || pin === undefined || pin === '') continue;
    const direction = (child.props || []).find((p) => p.name === 'direction')?.value === 'output' ? 'dout' : 'din';
    blocks.push({ id: nextBlockId, type: direction, gx: col * 3, gy: 0, data: { gpio: Number(pin) } });
    nextBlockId += 1;
    col += 1;
  }
  return { blocks, nextId: nextBlockId };
}

export async function sendDesign(design) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('design', new Blob([JSON.stringify(design)], { type: 'application/json' }), 'design.json');
    const res = await fetch(`${DEVICE_BASE}/save-design`, { method: 'POST', body: form, signal: controller.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    return text;
  } catch (err) {
    throw new Error(timeoutMessage(err));
  } finally {
    clearTimeout(timer);
  }
}
