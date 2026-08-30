// Web Serial + esptool-js — the only place noditron talks to real ESP32
// hardware. esptool-js (vendored at ../vendor/esptool-js, see its own
// README) is Espressif's own official in-browser flasher: it implements
// the real ROM bootloader SLIP protocol (chip auto-detect, stub upload,
// flash-download, MD5 verify), so nothing here reimplements that — this
// file is just the thin bit gluing it to one noditron block's dialog.
//
// One session per block id, not one global session, so more than one ESP32
// DevKit on canvas can each hold their own independent serial connection at
// once. A session only ever lives as long as the page does — a reload
// always drops it, same as any other Web Serial connection; nothing here
// tries to work around that.
import { ESPLoader, Transport } from '../vendor/esptool-js/esptool-js.bundle.js';
import { getStoredToken } from '/nodigraph/src/model/githubSync.js';

const sessions = new Map(); // blockId -> { port, transport, esploader, chipName, bootloaderOffset }

export function isSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function getSession(blockId) {
  return sessions.get(blockId) || null;
}

// Known, ready-to-flash firmware — release builds compiled from conucon's
// esp32_logic (see that repo's server.js FIRMWARE_TARGETS map, the source
// of truth for these offsets), committed here at the same firmware-assets/
// path rather than fetched cross-repo: noditron and conucon are both
// private, so one repo means one token's read access covers both the
// library manager's own modules and this firmware, instead of two. Fetched
// through the GitHub Contents API with the same shared token as
// library.js/nodigraph's own GitHubConnectDialog (getStoredToken) rather
// than a plain unauthenticated fetch — jsDelivr's CDN has no auth
// mechanism at all and could never reach a private repo, token or not.
// App-image-only (0x10000): flashing just the app over a board that
// already has a bootloader and partition table (the common case — a
// factory-fresh or previously-flashed ESP32 already does) reboots
// straight into it; a truly wiped chip still needs a bootloader/
// partitions file added as an ordinary manual row alongside this one.
const FIRMWARE_REPO = { owner: 'nodi-andy', repo: 'noditron', ref: 'main' };
export const FIRMWARE_PRESETS = [
  { id: 'logic-esp32', label: 'Logic — ESP32 (classic)', chip: 'ESP32', path: 'firmware-assets/logic/esp32.bin', address: 0x10000 },
  { id: 'logic-esp32-s3', label: 'Logic — ESP32-S3', chip: 'ESP32-S3', path: 'firmware-assets/logic/esp32-s3.bin', address: 0x10000 },
];

// The Contents API caps a readable file at 1MB (base64 included) — both
// current presets (~830-885KB) fit; a future firmware big enough to blow
// past that would need the Git Blobs API instead, not handled here yet.
export async function fetchPresetBytes(preset, token = getStoredToken()) {
  const { owner, repo, ref } = FIRMWARE_REPO;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${preset.path}?ref=${encodeURIComponent(ref)}`;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `token ${token}`;
  const res = await fetch(url, { cache: 'no-store', headers });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const needsToken = (res.status === 401 || res.status === 404) && !token;
    throw new Error(`${body?.message || `${res.status} ${res.statusText}`} fetching ${preset.label}${needsToken ? ' — this repo is private, add a GitHub token in the library dialog' : ''}`);
  }
  const file = await res.json();
  return Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
}

// A starting point only, for the standard Arduino-ESP32 partition layout —
// every row stays editable in the dialog. The one offset that genuinely
// varies by chip (the bootloader's — 0x0 on S3/C3/C6, 0x1000 on classic
// ESP32/S2, see esptool-js's own per-chip ROM classes) comes from the
// detected chip itself once connected, never guessed from a filename.
export function guessAddress(filename, bootloaderOffset) {
  const lower = filename.toLowerCase();
  if (lower.includes('bootloader')) return bootloaderOffset ?? 0x1000;
  if (lower.includes('partition')) return 0x8000;
  if (lower.includes('boot_app0')) return 0xe000;
  return 0x10000; // firmware.bin / app.bin, or a merged single image's app part
}

function describePort(port) {
  const info = port.getInfo?.() || {};
  if (info.usbVendorId !== undefined) {
    return `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${info.usbProductId.toString(16).padStart(4, '0')}`;
  }
  return 'serial port';
}

export async function connect(blockId, { onLog } = {}) {
  const port = await navigator.serial.requestPort();
  const transport = new Transport(port, true);
  const session = { port, transport, esploader: null, chipName: null, bootloaderOffset: null };
  sessions.set(blockId, session);
  onLog?.(`Port selected: ${describePort(port)}`);
  return session;
}

// Most ESP32 boards' auto-reset circuit wires DTR/RTS straight into
// GPIO0/EN (that's the whole mechanism esptool's own classicReset above
// uses to force chip into the ROM bootloader) — and opening a Web Serial
// port can leave both asserted by default, depending on the platform.
// Left asserted after a plain (re)open, that reads as "select the
// bootloader" on the very next reset, which is exactly what a freshly
// flashed board's own boot-up is — so skipping this leaves a board that
// flashed perfectly looping straight back into the bootloader forever
// instead of ever running the app that was just written to it.
// esptool-js's own classicReset (see esptool-js.bundle.js) ends its own
// sequence the same way, on the same reasoning.
async function releaseResetLines(transport) {
  await transport.setDTR(false);
  await transport.setRTS(false);
}

// Closes and reopens the same already-granted port with a brand new
// Transport, at a plain baud rate — no ESPLoader, no SLIP framing. Needed
// because ESPLoader's own connect (see detectChip below) starts a
// persistent internal read loop that never gives the port's reader lock
// back on its own (there's no "stop being in bootloader mode" call in
// esptool-js — only closing the port itself releases it), so the only way
// serialConsole.js's plain-text reads can follow a bootloader session on
// the *same* port is a full close/reopen cycle, not a mode switch.
export async function reopenPlain(blockId, baudrate = 115200) {
  const session = sessions.get(blockId);
  if (!session) throw new Error('Not connected — pick a serial port first.');
  try {
    await session.transport.disconnect();
  } catch {
    // Already closed, or never fully opened — nothing to release.
  }
  const transport = new Transport(session.port, true);
  await transport.connect(baudrate);
  await releaseResetLines(transport);
  const fresh = { port: session.port, transport, esploader: null, chipName: session.chipName, bootloaderOffset: session.bootloaderOffset };
  sessions.set(blockId, fresh);
  return fresh;
}

// The one place serialConsole.js should ever have to reach into serial
// port mechanics from — everything about *how* a plain connection gets
// opened (fresh vs. reopened after a bootloader session, and always with
// the reset lines released) lives here instead of being duplicated there.
export async function ensureOpenPlain(blockId, baudrate = 115200) {
  const session = sessions.get(blockId);
  if (!session) throw new Error('Not connected — pick a serial port first.');
  if (session.esploader) return reopenPlain(blockId, baudrate);
  if (!session.port.readable) {
    await session.transport.connect(baudrate);
    await releaseResetLines(session.transport);
  }
  return session;
}

// Resets the board, syncs with its ROM bootloader, and identifies the chip
// — this is what turns "a port is open" into "we know what's on the other
// end," and is a precondition for writeFlash (it needs esploader.chip to
// know per-chip flash timing/offsets). Always starts from a freshly
// (re)opened transport of its own, regardless of what state the port was
// in before (never opened, or already plain-opened for a console read) —
// ESPLoader's own connect() needs to open the device itself.
export async function detectChip(blockId, { onLog } = {}) {
  const session = sessions.get(blockId);
  if (!session) throw new Error('Not connected — pick a serial port first.');
  try {
    await session.transport.disconnect();
  } catch {
    // Never opened yet, or already closed — nothing to release.
  }
  const transport = new Transport(session.port, true);
  session.transport = transport;
  const terminal = { clean() {}, writeLine: (line) => onLog?.(line), write: (line) => onLog?.(line) };
  session.esploader = new ESPLoader({ transport, baudrate: 115200, terminal });
  session.chipName = await session.esploader.main();
  session.bootloaderOffset = session.esploader.chip.BOOTLOADER_FLASH_OFFSET;
  return { chipName: session.chipName, bootloaderOffset: session.bootloaderOffset };
}

// `files`: [{ name, address, file: File }] for a manually-picked file, or
// [{ name, address, bytes: Uint8Array }] for one fetched via a firmware
// preset above — either shape flashes the same way from here on.
// flashMode/Freq/Size all "keep" (esptool-js/esptool's own sentinel for
// "read it off the device, don't guess"), which is the right default for
// a board whose flash chip might be anything; the dialog never asks the
// user to pick those, only the per-file address.
export async function flash(blockId, files, { eraseAll = false, onProgress, onLog } = {}) {
  const session = sessions.get(blockId);
  if (!session?.esploader) throw new Error('Detect the chip before flashing.');
  const fileArray = [];
  for (const f of files) {
    const data = f.bytes ? f.bytes : new Uint8Array(await f.file.arrayBuffer());
    fileArray.push({ data, address: f.address });
  }
  await session.esploader.writeFlash({
    fileArray,
    flashMode: 'keep',
    flashFreq: 'keep',
    flashSize: 'keep',
    eraseAll,
    compress: true,
    reportProgress: (fileIndex, written, total) => onProgress?.(fileIndex, written, total),
  });
  await session.esploader.after('hard_reset');
  onLog?.('Flash complete — device reset.');
}

export async function disconnect(blockId) {
  const session = sessions.get(blockId);
  if (!session) return;
  sessions.delete(blockId);
  try {
    await session.transport.disconnect();
  } catch {
    // Already gone (unplugged, or never fully opened) — nothing left to close.
  }
}
