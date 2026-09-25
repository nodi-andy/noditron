// Offers to reconnect a board to the serial port it last used, and keeps
// `connectionState` honest when a board is unplugged.
//
// Web Serial remembers which ports a page was granted — getPorts() hands
// them back with no prompt — and serialMemory.js remembers which of those
// each board block used. What this deliberately does not do is open that
// port on load unasked: opening an ESP32-S3's native USB port resets the
// chip (see serialFlash.releaseResetLines), which is not something a page
// reload should do to a board that is busy driving real hardware. So a
// remembered board gets a small card at the bottom of the page and
// connects when its Connect is pressed — the same "ask first" a fresh
// Connect (COM) in the device dialog gives, minus the port picker.
//
// The card is also what a board plugged in later gets (navigator.serial's
// own 'connect' event), and 'disconnect' drops the session of a board
// that was pulled so the card on canvas stops claiming it is running.
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import * as serialFlash from './serialFlash.js';
import * as serialConsole from './serialConsole.js';
import * as devkitCircuit from './devkitCircuit.js';
import { reconcileWithDevice } from './deviceSync.js';
import { rememberedPort, findRememberedPort, describePortIdentity, rememberedWifi } from './serialMemory.js';

const HOST_ID = 'noditron-reconnect';

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
  }
  return host;
}

function button(text, primary = false) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = text;
  el.className = primary ? 'noditron-reconnect-primary' : '';
  return el;
}

export function installSerialReconnect(nodigraph, { openDialog = () => {} } = {}) {
  // Web Serial is only needed for the USB offers; a board last reached
  // over WiFi is offered back in any browser.
  const serialSupported = serialFlash.isSupported();
  const host = ensureHost();
  const cards = new Map(); // blockId -> card element

  function boards() {
    return devkitCircuit.collectBoardBlocks(nodigraph.project.rootBlock.children).map((entry) => entry.block);
  }

  function setState(block, value) {
    const prop = (block.props || []).find((p) => p.name === 'connectionState');
    if (!prop) return;
    prop.value = value;
    block.description = serializeBlockDescription(block);
    nodigraph.renderLoop.requestRender();
    nodigraph.persist();
  }

  // The first step the device dialog's own Connect takes (open, then ask
  // the console to identify itself) — but never its fallback into the ROM
  // bootloader (detectChip), which parks the chip. A board that does not
  // answer ping here stays open and is marked unknown; opening the dialog
  // then runs the full probe on that same session.
  async function connectTo(block, { port = null, wifiHost = null }) {
    setState(block, 'connecting');
    try {
      if (wifiHost) await serialFlash.connectWifi(block.id, wifiHost);
      else await serialFlash.connect(block.id, { port });
      const info = await serialConsole.identify(block.id);
      setState(block, info.verified ? 'connected:running' : 'connected:unknown');
      // A running board says what it holds; the block settles against
      // that (see deviceSync.js) rather than against the last page load.
      // Only a DevKit holds a circuit to settle; a CNC module has none.
      const isDevkit = (block.props || []).find((p) => p.name === 'noditronKind')?.value === 'esp32-devkit';
      if (info.verified && isDevkit) {
        try {
          const result = await reconcileWithDevice(nodigraph, block);
          info.reconcile = result;
        } catch (err) {
          console.warn(`[noditron] ${block.name}: could not read the circuit on the device:`, err.message);
        }
      }
      return info;
    } catch (err) {
      serialConsole.closeConsole(block.id);
      await serialFlash.disconnect(block.id);
      setState(block, 'disconnected');
      throw err;
    }
  }

  function removeCard(blockId) {
    cards.get(blockId)?.remove();
    cards.delete(blockId);
  }

  function offer(block, { port = null, wifiHost = null }) {
    removeCard(block.id);
    const card = document.createElement('div');
    card.className = 'noditron-reconnect-card';
    const text = document.createElement('div');
    text.className = 'noditron-reconnect-text';
    const title = document.createElement('div');
    const name = block.name || 'ESP32';
    title.textContent = wifiHost
      ? `${name} answers at ${wifiHost} over WiFi. Reconnect?`
      : `${name} was on ${describePortIdentity(port)}. Reconnect?`;
    const note = document.createElement('small');
    note.textContent = wifiHost ? 'No cable needed.' : 'Opening the port resets the board.';
    text.append(title, note);
    const connectBtn = button('Connect', true);
    const laterBtn = button('Not now');
    laterBtn.addEventListener('click', () => removeCard(block.id));
    connectBtn.addEventListener('click', async () => {
      connectBtn.disabled = true;
      laterBtn.disabled = true;
      title.textContent = `Connecting ${name}…`;
      note.textContent = 'Waiting for the board to answer.';
      try {
        const info = await connectTo(block, { port, wifiHost });
        removeCard(block.id);
        // No Logic Module answered: the dialog is where the firmware
        // options live, so hand over to it rather than leaving a board
        // that reads "no firmware answer" with nothing to do about it.
        if (!info.verified) openDialog(block);
      } catch (err) {
        title.textContent = `${name}: ${err.message}`;
        note.textContent = '';
        connectBtn.textContent = 'Retry';
        connectBtn.disabled = false;
        laterBtn.disabled = false;
      }
    });
    card.append(text, connectBtn, laterBtn);
    host.appendChild(card);
    cards.set(block.id, card);
  }

  // `candidates` narrows the offer to specific ports (a board just
  // plugged in); by default every port the page was ever granted is
  // considered. A port held by a live session, or already offered to
  // another board, is not offered twice.
  async function offerAll(candidates = null) {
    let ports = candidates || [];
    if (!candidates && serialSupported) {
      try {
        ports = await navigator.serial.getPorts();
      } catch {
        ports = [];
      }
    }
    const taken = new Set();
    for (const block of boards()) {
      const session = serialFlash.getSession(block.id);
      if (session?.port) taken.add(session.port);
    }
    for (const block of boards()) {
      if (serialFlash.getSession(block.id) || cards.has(block.id)) continue;
      const port = findRememberedPort(rememberedPort(block.id), ports, taken);
      if (!port) continue;
      taken.add(port);
      offer(block, { port });
    }
    if (candidates) return;
    // A board last reached over WiFi: offered only if it answers there now,
    // as a Logic Module, so a stale address never produces a card.
    for (const block of boards()) {
      if (serialFlash.getSession(block.id) || cards.has(block.id)) continue;
      const wifiHost = rememberedWifi(block.id);
      if (!wifiHost) continue;
      try {
        const res = await fetch(`http://${wifiHost}/api/version`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        const version = await res.json();
        const isBoard = version && (version.type === 'logic' || version.type === 'cnc');
        if (isBoard && !serialFlash.getSession(block.id) && !cards.has(block.id)) offer(block, { wifiHost });
      } catch {
        // Not there right now.
      }
    }
  }

  if (!serialSupported) {
    offerAll();
    return { offerAll };
  }

  navigator.serial.addEventListener('connect', (event) => {
    const port = event.port || event.target;
    if (port) offerAll([port]);
  });
  navigator.serial.addEventListener('disconnect', async (event) => {
    const port = event.port || event.target;
    const found = port && serialFlash.findSessionByPort(port);
    if (!found) return;
    serialConsole.closeConsole(found.blockId);
    await serialFlash.disconnect(found.blockId);
    const block = boards().find((b) => b.id === found.blockId);
    if (block) setState(block, 'disconnected');
  });

  offerAll();
  return { offerAll };
}
