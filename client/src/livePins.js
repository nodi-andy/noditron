// A single shared poller per connected ESP32 DevKit block, so the device
// dialog's own "Live Pins" panel and any number of on-canvas Digital I/O
// (Bool) blocks reading a live input pin all read from one cache instead of
// each running their own independent readPins() loop against the same
// serial link. Self-terminating: a caller "touches" the cache every time it
// actually wants fresh data (see ensurePolling below); if nothing touches a
// given board for 2s (the dialog closed and no on-canvas block for it is
// being drawn any more), its loop stops itself rather than polling forever.
import { readPins, subscribeIoChanges } from './serialConsole.js';

// Change events provide normal updates. This slow snapshot is only the
// initial state and a recovery path if a serial event was lost.
const POLL_GAP_MS = 5000;
const IDLE_TIMEOUT_MS = 2000;

const boards = new Map(); // parentBlockId -> { pins, polling, lastTouched }

function entryFor(parentBlockId) {
  let entry = boards.get(parentBlockId);
  if (!entry) {
    entry = { pins: null, polling: false, lastTouched: 0 };
    boards.set(parentBlockId, entry);
  }
  return entry;
}

// Synchronous — returns whatever the last successful poll saw, or null if
// nothing's been read yet. Never itself triggers a read; call
// ensurePolling() to make sure one is actually running.
export function getCachedPins(parentBlockId) {
  return boards.get(parentBlockId)?.pins || null;
}

// Idempotent and cheap to call from a per-frame draw path — starts the
// board's poll loop if it isn't already running, and resets its idle timer
// either way. A self-scheduling loop, not setInterval, so a slow reply can
// never stack a second request behind the first on the same serial link.
export function ensurePolling(parentBlockId, inputs = null) {
  const entry = entryFor(parentBlockId);
  if (inputs) entry.inputs = inputs;
  if (!entry.unsubscribe) {
    entry.unsubscribe = subscribeIoChanges(parentBlockId, (pins) => {
      const merged = new Map((entry.pins || []).map(pin => [Number(pin.gpio), pin]));
      for (const pin of pins) merged.set(Number(pin.gpio), pin);
      entry.pins = [...merged.values()];
    });
  }
  entry.lastTouched = Date.now();
  if (entry.polling) return;
  entry.polling = true;
  (async function loop() {
    while (entry.polling) {
      if (Date.now() - entry.lastTouched > IDLE_TIMEOUT_MS) {
        entry.polling = false;
        break;
      }
      try {
        entry.pins = await readPins(parentBlockId, { timeoutMs: 1500, inputs: entry.inputs || [] });
      } catch (_) {
        // A missed poll just leaves the cache showing the last known state.
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_GAP_MS));
    }
  })();
}
