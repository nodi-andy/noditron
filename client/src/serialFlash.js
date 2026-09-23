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

// esptool-js's Transport takes `tracing` as its second argument, and this
// was passing `true` at every call site — which prints a console line for
// every single chunk read or written ("TRACE 34502.000 Read 10 bytes:
// 7065223a22696f222c22"), thousands of them, burying anything the app
// itself has to say. It is a protocol-debugging aid for esptool-js, not
// something this app needs; flip it back on here if you are ever
// debugging the flasher's own framing. What the *device* says is logged
// separately and legibly (see serialConsole.js).
const TRACE_SERIAL = false;
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
//
// Each preset is a full bundle — bootloader + partition table + OTA
// slot-selector + app — written together in one writeFlash() call, never
// just the app image alone. That used to be app-only, on the assumption a
// board already had a bootloader and partition table from some earlier
// flash; a genuinely blank (or fully erased) chip has neither, so that
// assumption bricked one — the ROM's own boot log loops "invalid header:
// 0xffffffff" forever with no bootloader at 0x1000 to hand off to. conucon's
// own installer hit and fixed the exact same bug once already (see its
// server.js comment above FIRMWARE_TARGETS) — always writing the full set
// is what it settled on, since rewriting an unchanged bootloader/partition
// table on a board that already had one is a harmless no-op. boot_app0.bin
// is chip-family-independent (just OTA slot-select metadata), so one copy
// covers every target; bootloader.bin and partitions.bin are per chip
// family (offsets, and on some cores their actual bytes, differ).
const FIRMWARE_REPO = { owner: 'nodi-andy', repo: 'noditron', ref: 'main' };
const BOOT_APP0 = { path: 'firmware-assets/boot_app0.bin', address: 0xe000 };
export const FIRMWARE_PRESETS = [
  {
    id: 'logic-esp32',
    label: 'Logic — ESP32 (classic)',
    chip: 'ESP32',
    parts: [
      { path: 'firmware-assets/logic/esp32-bootloader.bin', address: 0x1000 },
      { path: 'firmware-assets/logic/esp32-partitions.bin', address: 0x8000 },
      BOOT_APP0,
      { path: 'firmware-assets/logic/esp32.bin', address: 0x10000 },
    ],
  },
  {
    id: 'logic-esp32-s3',
    label: 'Logic — ESP32-S3',
    chip: 'ESP32-S3',
    parts: [
      // 0x0, not the classic's 0x1000. The Arduino core states this per
      // chip family and the two genuinely differ — its boards.txt has
      // `esp32s3.build.bootloader_addr=0x0` against
      // `esp32.build.bootloader_addr=0x1000` — so an S3 bootloader written
      // where a classic one goes leaves a board that never boots.
      { path: 'firmware-assets/logic/esp32-s3-bootloader.bin', address: 0x0 },
      { path: 'firmware-assets/logic/esp32-s3-partitions.bin', address: 0x8000 },
      BOOT_APP0,
      { path: 'firmware-assets/logic/esp32-s3.bin', address: 0x10000 },
    ],
  },
];

// The Contents API caps a readable file at 1MB (base64 included) — every
// part of every preset here (~830-905KB at the largest) fits; a future
// firmware big enough to blow past that would need the Git Blobs API
// instead, not handled here yet.
async function fetchAssetBytes(path, label, token) {
  const { owner, repo, ref } = FIRMWARE_REPO;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `token ${token}`;
  const res = await fetch(url, { cache: 'no-store', headers });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const needsToken = (res.status === 401 || res.status === 404) && !token;
    throw new Error(`${body?.message || `${res.status} ${res.statusText}`} fetching ${label}${needsToken ? ' — this repo is private, add a GitHub token in the library dialog' : ''}`);
  }
  const file = await res.json();
  return Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
}

// Every part of a preset, ready to hand straight to flash() below — fetched
// in parallel (they're independent GitHub Contents API requests), returned
// in the same bootloader-first order the preset itself lists them in.
export async function fetchPresetParts(preset, token = getStoredToken()) {
  return Promise.all(
    preset.parts.map(async (part) => ({
      name: part.path.split('/').pop(),
      address: part.address,
      bytes: await fetchAssetBytes(part.path, `${preset.label} (${part.path.split('/').pop()})`, token),
    })),
  );
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
  const transport = new Transport(port, TRACE_SERIAL);
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
  const transport = new Transport(session.port, TRACE_SERIAL);
  await transport.connect(baudrate);
  await releaseResetLines(transport);
  const fresh = { port: session.port, transport, esploader: null, bootloaderDirty: false, chipName: session.chipName, bootloaderOffset: session.bootloaderOffset };
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
  // `bootloaderDirty`, not just `esploader`: a detect that *failed* leaves
  // the port just as tainted as one that worked — esptool-js has already
  // opened it and started its read loop by the time the sync gives up —
  // and only a close/reopen gets the reader lock back for plain text.
  if (session.esploader || session.bootloaderDirty) return reopenPlain(blockId, baudrate);
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
  const transport = new Transport(session.port, TRACE_SERIAL);
  session.transport = transport;
  session.bootloaderDirty = true; // see ensureOpenPlain — true even if the sync below fails
  const terminal = { clean() {}, writeLine: (line) => onLog?.(line), write: (line) => onLog?.(line) };
  const esploader = new ESPLoader({ transport, baudrate: 115200, terminal });
  // Only published to the session once it is actually connected. A loader
  // whose main() threw has no `.chip`, and writeFlash reads
  // chip.BOOTLOADER_FLASH_OFFSET straight off it — so leaving a failed one
  // in place turned the next Install into "Cannot read properties of
  // undefined (reading 'BOOTLOADER_FLASH_OFFSET')", which says nothing
  // about the board never having answered in the first place.
  try {
    session.chipName = await esploader.main();
  } catch (err) {
    session.esploader = null;
    session.chipName = null;
    session.bootloaderOffset = null;
    // esptool-js has already retried its reset sequence seven times by
    // here, so this is the board not entering download mode rather than a
    // timing fluke — which on most DevKits is the auto-reset circuit and
    // is worked around by hand.
    throw new Error(`${err.message} — hold the board's BOOT/FLASH button, tap EN/RST, then try again.`);
  }
  session.esploader = esploader;
  session.bootloaderOffset = esploader.chip.BOOTLOADER_FLASH_OFFSET;
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
  let session = sessions.get(blockId);
  if (!session) throw new Error('Not connected — pick a serial port first.');
  // Install is reachable with no live bootloader session behind it: the
  // firmware panel is shown whenever the console said nothing, including
  // when the chip detect that followed also failed (see the dialog's
  // afterPortOpen). Rather than refusing, connect now — the board may
  // well have been put into download mode by hand since — and let the
  // connect error speak for itself if it still will not answer.
  if (!session.esploader) {
    onLog?.('No bootloader session — connecting to the chip first...');
    await detectChip(blockId, { onLog });
    session = sessions.get(blockId);
  }
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
