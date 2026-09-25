// Which serial port each board block last used, kept across page loads so
// a reload can offer to pick the same board straight back up (see
// serialReconnect.js). Web Serial gives a page no stable id for a port —
// only its USB vendor/product ids, and only for a USB port — so two
// identical boards are told apart only by which one is not already taken.
//
// Pure functions over a storage object with localStorage's shape, so the
// matching can be tested in node without a browser; the default storage
// is the real localStorage when there is one.
const PREFIX = 'noditron.serialPort.';

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function portIdentity(port) {
  let info = {};
  try {
    info = port?.getInfo?.() || {};
  } catch {
    info = {};
  }
  return { usbVendorId: info.usbVendorId ?? null, usbProductId: info.usbProductId ?? null };
}

export function describePortIdentity(portOrIdentity) {
  const identity = portOrIdentity && typeof portOrIdentity.getInfo === 'function' ? portIdentity(portOrIdentity) : portOrIdentity || {};
  if (identity.usbVendorId != null) {
    const hex = (n) => Number(n).toString(16).padStart(4, '0');
    return `USB ${hex(identity.usbVendorId)}:${hex(identity.usbProductId ?? 0)}`;
  }
  return 'serial port';
}

export function sameIdentity(a, b) {
  return Boolean(a && b) && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
}

// Only a USB port is worth remembering: without vendor/product ids there
// is nothing to recognise it by on the next load.
export function rememberPort(blockId, port, storage = defaultStorage()) {
  const identity = { ...portIdentity(port), at: Date.now() };
  if (!storage || identity.usbVendorId == null) return null;
  try {
    storage.setItem(PREFIX + blockId, JSON.stringify(identity));
  } catch {
    return null;
  }
  return identity;
}

export function rememberedPort(blockId, storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PREFIX + blockId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.usbVendorId != null ? parsed : null;
  } catch {
    return null;
  }
}

export function forgetPort(blockId, storage = defaultStorage()) {
  try {
    storage?.removeItem(PREFIX + blockId);
  } catch {
    // Nothing to forget, or nowhere it could have been kept.
  }
}

// The first granted port that is what was remembered, skipping any in
// `taken` (a port another board already holds or was already offered).
export function findRememberedPort(remembered, ports, taken = new Set()) {
  if (!remembered || remembered.usbVendorId == null) return null;
  for (const port of ports || []) {
    if (taken.has(port)) continue;
    if (sameIdentity(portIdentity(port), remembered)) return port;
  }
  return null;
}

// The address a board was last reached at over WiFi (see serialFlash's
// connectWifi), so the next load can offer that link back as well.
const WIFI_PREFIX = 'noditron.wifiHost.';

export function rememberWifi(blockId, host, storage = defaultStorage()) {
  try {
    if (host) storage?.setItem(WIFI_PREFIX + blockId, String(host));
  } catch {
    // Nowhere to keep it.
  }
}

export function rememberedWifi(blockId, storage = defaultStorage()) {
  try {
    return storage?.getItem(WIFI_PREFIX + blockId) || null;
  } catch {
    return null;
  }
}

export function forgetWifi(blockId, storage = defaultStorage()) {
  try {
    storage?.removeItem(WIFI_PREFIX + blockId);
  } catch {
    // Nothing to forget.
  }
}
