// The Add Block window — what nodigraph's own + button opens in noditron.
// nodigraph's button adds an empty block; here it is taken over (a
// capture-phase listener on the same element, so nodigraph's own handler
// never runs and nodigraph itself stays unmodified) and opens this window
// instead: every primitive from palette.js in its group, and a Modules
// group where a board is added by connecting to it.
//
// Connect USB picks a serial port (the browser's own chooser), Connect IP
// takes an address; either way the board is asked who it is (`ping`, see
// serialConsole.identify) and the module it turns out to be is placed for
// it — from this project's installed modules, this server's bundled ones,
// or a GitHub repo, in that order (see library.resolveModuleByName). The
// link stays open and becomes the block's own (see serialFlash.adoptSession),
// so the board is connected the moment it appears; its console moves with
// it (serialConsole.adoptConsole), still reading.
//
// Then the board is asked for its neighbours (`nodes`): every node it
// hears on the CAN bus is placed beside it, and the two are wired CAN to
// CAN — the bus the boards are physically on, drawn. A CNC module wired
// to a Logic Module over CAN therefore appears the moment either of them
// is added. (A node heard over WiFi has its own address to be added by.)
// A CAN neighbour is online through the board that hears it (see
// canBridge.js): its shell runs as `node <name> <line>` on the bridge.
import { generateId } from '/nodigraph/src/model/Block.js';
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { paletteGroups } from './palette.js';
import { getInstalledModules, listBundledModules, fetchManifest, addModuleBlock, resolveModuleByName } from './library.js';
import { getAllowedChildKinds, prepareAdd, addTarget } from './containerRestrictions.js';
import * as serialFlash from './serialFlash.js';
import * as serialConsole from './serialConsole.js';
import { moduleNameFor, MODULE_NAMES } from './moduleDiscovery.js';
import { findContainingLevel } from './devkitCircuit.js';
import { setBlockProp, findBoardByNodeId, scanAndPlaceNeighbours, describeNeighbours } from './canNeighbours.js';

// The bus-drawing helpers moved to canNeighbours.js (the board page and
// the bridge poll place neighbours too); kept exported from here for
// whoever imported them from the window.
export { wireCan, canPortOf } from './canNeighbours.js';

const HOST_ID = 'noditron-add-host';
// The embedded build (a page a board serves, see tools/build-board-site.mjs)
// offers only what the board's firmware runs — no Weather, LED or JSON
// Field, which live in the browser — and no USB, which a page over plain
// HTTP cannot open.
const EMBEDDED = () => Boolean(window.nodigraphEmbedded);
const EMBEDDED_KINDS = new Set(['digital-io', 'and', 'or', 'gate', 'not', 'state', 'data', 'add', 'timer',
  'boot', 'slice', 'route', 'croute', 'pwmout', 'pwmin', 'serial', 'serialin', 'can', 'i2cout', 'i2cin']);
const LAST_HOST_KEY = 'noditron.addBlock.lastHost';

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.hidden = true;
    document.body.appendChild(host);
  }
  return host;
}

function propOf(block, name) {
  return (block?.props || []).find((p) => p.name === name)?.value;
}

function moduleLabel(info) {
  const what = info.kind === 'cnc' ? 'CNC module' : 'Logic Module';
  return `${what}${info.nodeName ? ` ${info.nodeName}` : ''}${info.node ? ` (node ${info.node})` : ''}`;
}

export function installAddBlockDialog(nodigraph) {
  const host = ensureHost();
  // A link that identified nothing, kept open while the window offers to
  // place a board for it anyway (so its dialog can install firmware).
  let pendingLink = null;

  async function dropPendingLink() {
    if (!pendingLink) return;
    const { tempId } = pendingLink;
    pendingLink = null;
    serialConsole.closeConsole(tempId);
    await serialFlash.disconnect(tempId, { forget: true });
  }

  function close() {
    host.hidden = true;
    host.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    dropPendingLink();
  }

  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  async function placeModuleByName(name) {
    const { manifest, source } = await resolveModuleByName(nodigraph, name);
    return addModuleBlock(nodigraph, manifest, source)[0];
  }

  // Everything after a link is open: who is there, which module that is,
  // place it (or find it already placed), hand it the link, then its CAN
  // neighbours. Throws with the link closed on any failure before the
  // hand-over; after it, the block owns the link and keeps it.
  async function identifyAndPlace(tempId, { nativeUsb }, status) {
    status('Asking who is there...');
    const info = await serialConsole.identify(tempId, { timeoutMs: 6000 });
    if (!info.verified) return { info, board: null };

    const name = moduleNameFor(info.kind, { nativeUsb, board: info.board });
    status(`${moduleLabel(info)}: placing ${name}...`);
    const existing = findBoardByNodeId(nodigraph, info.node);
    let board = existing?.block || null;
    let boardLevel = existing?.level || null;
    if (!board) {
      prepareAdd(nodigraph);
      board = await placeModuleByName(name);
      if (info.nodeName) board.name = info.nodeName;
      boardLevel = findContainingLevel(nodigraph.project.rootBlock.children, board.id);
    }
    serialConsole.adoptConsole(tempId, board.id);
    serialFlash.adoptSession(tempId, board.id);
    setBlockProp(board, 'nodeId', info.node || '');
    setBlockProp(board, 'nodeName', info.nodeName || '');
    setBlockProp(board, 'connectionState', 'connected:running');
    nodigraph.selection.select(board.id);
    nodigraph.persist();
    nodigraph.renderLoop.requestRender();

    status(`${moduleLabel(info)} connected. Scanning its bus (nodes)...`);
    // Its CAN neighbours placed beside it and wired, into the level being
    // edited — the board's own unless the board was found already sitting
    // somewhere else (see canNeighbours.js).
    const scan = await scanAndPlaceNeighbours(nodigraph, board, { status });
    nodigraph.selection.select(board.id);
    nodigraph.persist();
    nodigraph.renderLoop.requestRender();
    status(describeNeighbours(`${moduleLabel(info)} added`, scan));
    return { info, board };
  }

  async function connectAndPlace(kind, host_, status) {
    await dropPendingLink();
    const tempId = `add:${Date.now()}`;
    let nativeUsb = null;
    try {
      if (kind === 'usb') {
        if (!serialFlash.isSupported()) throw new Error('Web Serial is not available in this browser (Chrome or Edge on desktop).');
        const port = await navigator.serial.requestPort();
        status('Opening the port...');
        await serialFlash.connect(tempId, { port, onLog: status });
        nativeUsb = serialFlash.usesNativeUsb(port);
      } else {
        status(`Connecting to ${host_}...`);
        await serialFlash.connectWifi(tempId, host_, { onLog: status });
        try { localStorage.setItem(LAST_HOST_KEY, serialFlash.cleanHost(host_)); } catch { /* storage off */ }
      }
    } catch (err) {
      await serialFlash.disconnect(tempId, { forget: true });
      throw err;
    }
    let result;
    try {
      result = await identifyAndPlace(tempId, { nativeUsb }, status);
    } catch (err) {
      serialConsole.closeConsole(tempId);
      await serialFlash.disconnect(tempId, { forget: true });
      throw err;
    }
    if (!result.board) pendingLink = { tempId, nativeUsb };
    return result;
  }

  // The board answered nothing, but the link is open: place a board for
  // it anyway and hand it the link — its own dialog offers the firmware.
  async function placeUnverified(name) {
    if (!pendingLink) return null;
    const { tempId } = pendingLink;
    pendingLink = null;
    prepareAdd(nodigraph);
    const board = await placeModuleByName(name);
    serialConsole.adoptConsole(tempId, board.id);
    serialFlash.adoptSession(tempId, board.id);
    setBlockProp(board, 'connectionState', 'connected:unknown');
    nodigraph.selection.select(board.id);
    nodigraph.persist();
    nodigraph.renderLoop.requestRender();
    return board;
  }

  function tile({ swatchColor, text, sub = '', disabled = false, title = '' }, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'noditron-add-tile';
    button.disabled = disabled;
    if (title) button.title = title;
    const swatch = document.createElement('span');
    swatch.className = 'noditron-swatch';
    swatch.style.background = swatchColor;
    const label = document.createElement('span');
    label.className = 'noditron-add-tile-label';
    label.textContent = text;
    button.append(swatch, label);
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'noditron-add-tile-sub';
      subEl.textContent = sub;
      button.appendChild(subEl);
    }
    button.addEventListener('click', onClick);
    return button;
  }

  function group(labelText) {
    const section = document.createElement('section');
    section.className = 'noditron-add-group';
    const label = document.createElement('div');
    label.className = 'noditron-add-group-label';
    label.textContent = labelText;
    const grid = document.createElement('div');
    grid.className = 'noditron-add-grid';
    section.append(label, grid);
    return { section, grid };
  }

  async function open() {
    host.innerHTML = '';
    host.hidden = false;
    document.addEventListener('keydown', onKey);

    const backdrop = document.createElement('div');
    backdrop.className = 'noditron-dialog-backdrop';
    backdrop.addEventListener('click', close);
    const panel = document.createElement('div');
    panel.className = 'noditron-dialog-panel noditron-add-panel';
    panel.addEventListener('click', (event) => event.stopPropagation());
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'noditron-dialog-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', close);
    const title = document.createElement('h3');
    title.className = 'noditron-add-title';
    const target = addTarget(nodigraph);
    const targetName = target && target.id !== nodigraph.project.rootBlock?.id ? target.name : '';
    title.textContent = targetName ? `Add block into ${targetName}` : 'Add block';
    panel.append(closeBtn, title);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);

    const allowed = getAllowedChildKinds(nodigraph);

    // ── Modules: a board by its link, or a module placed on its own. ──
    if (allowed === null) {
      const modules = group('Modules');
      panel.appendChild(modules.section);
      const status = document.createElement('div');
      status.className = 'noditron-add-status';
      const setStatus = (text, isError = false) => {
        status.textContent = text;
        status.classList.toggle('is-error', isError);
      };
      const choice = document.createElement('div');
      choice.className = 'noditron-add-grid';
      choice.hidden = true;
      const ipForm = document.createElement('form');
      ipForm.className = 'noditron-add-form';
      ipForm.hidden = true;
      const ipInput = document.createElement('input');
      ipInput.type = 'text';
      ipInput.placeholder = 'Board address: its IP or name, or 192.168.0.1 on its own access point';
      try { ipInput.value = localStorage.getItem(LAST_HOST_KEY) || ''; } catch { /* storage off */ }
      const ipGo = document.createElement('button');
      ipGo.type = 'submit';
      ipGo.textContent = 'Connect';
      const scanBtn = document.createElement('button');
      scanBtn.type = 'button';
      scanBtn.textContent = 'Scan network';
      scanBtn.className = 'noditron-add-scan';
      scanBtn.title = 'Ask every host of this computer\'s local subnets whether it is a board (a few seconds)';
      ipForm.append(ipInput, ipGo, scanBtn);
      // Boards the server knows of on the network (see server/src/
      // lanDiscovery.js): heard by their UDP hello the moment the form
      // opens, and found by the sweep the Scan button starts. Each is a
      // tile; clicking one connects to that address.
      const found = document.createElement('div');
      found.className = 'noditron-add-grid noditron-add-found';
      found.hidden = true;
      modules.section.append(ipForm, found, status, choice);
      let scanning = false;
      async function loadBoards(scan) {
        if (scanning) return;
        scanning = true;
        scanBtn.disabled = true;
        if (scan) setStatus('Scanning the local network for boards...');
        try {
          const res = await fetch(`/api/discover${scan ? '?scan=1' : ''}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`discover failed (${res.status})`);
          const { boards, subnets } = await res.json();
          if (host.hidden) return;
          found.innerHTML = '';
          for (const b of boards) {
            const what = b.type === 'cnc' ? 'CNC module' : b.type === 'logic' ? 'Logic Module' : b.type;
            found.appendChild(tile({
              swatchColor: b.type === 'cnc' ? '#7c3aed' : '#2f6fed',
              text: `${what}${b.name ? ` ${b.name}` : ''}`,
              sub: `${b.ip}${b.build ? ` · build ${b.build}` : ''}${b.via === 'hello' ? ' · heard' : ''}`,
            }, () => { ipInput.value = b.ip; run('wifi', b.ip); }));
          }
          found.hidden = !boards.length;
          if (scan) {
            setStatus(boards.length
              ? `${boards.length} board${boards.length === 1 ? '' : 's'} on ${subnets.join(', ') || 'the network'}. Click one to connect.`
              : `No board answered on ${subnets.join(', ') || 'this computer\'s subnets'}. A board on its own access point is at 192.168.0.1 once this computer joins it.`);
          } else if (boards.length) {
            setStatus(`${boards.length} board${boards.length === 1 ? '' : 's'} heard on the network. Click one to connect, or Scan network to look further.`);
          }
        } catch (err) {
          setStatus(err.message, true);
        } finally {
          scanning = false;
          scanBtn.disabled = false;
        }
      }
      scanBtn.addEventListener('click', () => loadBoards(true));

      let busy = false;
      async function run(kind, host_) {
        if (busy) return;
        busy = true;
        choice.hidden = true;
        choice.innerHTML = '';
        try {
          const { info, board } = await connectAndPlace(kind, host_, setStatus);
          if (board) {
            setTimeout(close, 900);
            return;
          }
          setStatus(info.booting
            ? 'The board is starting but nothing answered as a module yet. Place it anyway to install or check its firmware from its own dialog:'
            : 'Nothing answered on this link. The board may have no firmware yet; place it anyway and install one from its own dialog:', true);
          choice.hidden = false;
          for (const name of MODULE_NAMES) {
            choice.appendChild(tile({ swatchColor: '#8b93a3', text: `Place ${name}` }, async () => {
              try {
                await placeUnverified(name);
                close();
              } catch (err) {
                setStatus(err.message, true);
              }
            }));
          }
        } catch (err) {
          setStatus(err.message, true);
        } finally {
          busy = false;
        }
      }

      const serialOk = serialFlash.isSupported() && !EMBEDDED();
      modules.grid.appendChild(tile({
        swatchColor: '#3ecf5d',
        text: 'Connect USB',
        sub: 'pick a serial port; the board says which module it is',
        disabled: !serialOk,
        title: serialOk ? '' : 'Web Serial is not available in this browser (Chrome or Edge on desktop)',
      }, () => { ipForm.hidden = true; run('usb'); }));
      modules.grid.appendChild(tile({
        swatchColor: '#2f6fed',
        text: 'Connect IP',
        sub: 'a board on the network, by address',
      }, () => {
        ipForm.hidden = !ipForm.hidden;
        found.hidden = ipForm.hidden || !found.childElementCount;
        if (!ipForm.hidden) {
          ipInput.focus();
          loadBoards(false);
        }
      }));
      ipForm.addEventListener('submit', (event) => {
        event.preventDefault();
        run('wifi', ipInput.value);
      });

      // Modules placed on their own, unconnected: every one this server
      // bundles, plus those this project installed from elsewhere.
      const known = new Map();
      for (const mod of getInstalledModules(nodigraph)) known.set(mod.name, mod);
      try {
        for (const mod of await listBundledModules()) if (!known.has(mod.name)) known.set(mod.name, mod);
      } catch (err) {
        setStatus(err.message, true);
      }
      if (host.hidden) return; // closed while the list was loading
      for (const mod of known.values()) {
        modules.grid.appendChild(tile({ swatchColor: mod.swatchColor || '#8b93a3', text: mod.displayName, sub: mod.version ? `v${mod.version}` : '' }, async () => {
          try {
            const manifest = await fetchManifest(mod.owner, mod.repo, mod.ref, mod.path);
            prepareAdd(nodigraph);
            addModuleBlock(nodigraph, manifest, mod);
            close();
          } catch (err) {
            setStatus(`Couldn't add ${mod.displayName}: ${err.message}`, true);
          }
        }));
      }
    }

    // ── The primitives, grouped; only the kinds this container allows. ──
    for (const { label, entries } of paletteGroups(nodigraph)) {
      const visible = entries.filter((entry) => (allowed === null || allowed.includes(entry.kind)) && (!EMBEDDED() || EMBEDDED_KINDS.has(entry.kind)));
      if (!visible.length) continue;
      const g = group(label);
      for (const entry of visible) {
        g.grid.appendChild(tile({ swatchColor: entry.swatchColor, text: entry.text }, () => {
          prepareAdd(nodigraph);
          entry.create();
          close();
        }));
      }
      panel.appendChild(g.section);
    }
  }

  // nodigraph's + button, taken over: at the target, capture listeners run
  // before nodigraph's own bubble-phase one, and stopImmediatePropagation
  // keeps that one from adding its empty block.
  const fab = document.getElementById('fab-add-block');
  fab?.addEventListener('click', (event) => {
    event.stopImmediatePropagation();
    event.preventDefault();
    open();
  }, { capture: true });

  return { open, close };
}
