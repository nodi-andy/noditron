// The page a Logic Module serves of itself (window.nodigraphEmbedded, see
// tools/build-board-site.mjs) is that board's page: the board is what the
// diagram is about, so it is there from the first look — not nodigraph's
// worked example of Block A, B, C — already connected to the board the
// page came from, holding the circuit the board runs, and open, so the
// canvas is the inside of the board where the circuit is drawn.
//
// How: the board says who it is at /api/version (same origin, no address
// to type); the block with that node id is found in the project, or placed
// from the module the board's kind names (esp32-s3-devkit for a logic
// board answering over the network, as the Add Block window would place
// it) after the example blocks are cleared. Then the same steps the
// reconnect card takes (serialReconnect.js's connectTo): open the WiFi
// link to the page's own host, identify, settle the block against what
// the device holds (deviceSync.js — an empty block takes the device's
// circuit). Then the block is entered. The project, board block included,
// is kept by the board itself (/api/project, see nodigraph's store.js), so
// the next visit finds the block and only reconnects.
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import * as serialFlash from './serialFlash.js';
import * as serialConsole from './serialConsole.js';
import { reconcileWithDevice } from './deviceSync.js';
import { collectBoardBlocks } from './devkitCircuit.js';
import { resolveModuleByName, addModuleBlock } from './library.js';
import { moduleNameFor } from './moduleDiscovery.js';
import { scanAndPlaceNeighbours, describeNeighbours } from './canNeighbours.js';

const EXAMPLE_NAMES = ['Block A', 'Block B', 'Block C'];

function propOf(block, name) {
  return (block?.props || []).find((p) => p.name === name)?.value;
}

function setProp(block, name, value) {
  let prop = (block.props || []).find((p) => p.name === name);
  if (prop) prop.value = value;
  else block.props.push({ id: `${block.id}:${name}`, name, kind: 'value', value });
  block.description = serializeBlockDescription(block);
}

// Who serves this page: the board's own /api/version, or null when the
// page is not a board's (no answer, or not a Logic Module's answer).
export async function whoServesThisPage(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const info = await res.json();
    if (!info || typeof info !== 'object' || !info.node) return null;
    if (info.type !== 'logic' && info.type !== 'cnc') return null;
    return info;
  } catch {
    return null;
  }
}

// The module for the board this page came from. A logic board reached over
// the network is the S3 unless it says it is the classic DevKit by name.
export function moduleNameForBoard(info) {
  if (info?.type === 'logic' && /^esp32(-devkit)?$/i.test(String(info.name || ''))) return 'esp32-devkit';
  return moduleNameFor(info?.type, { nativeUsb: null });
}

// nodigraph's worked example, untouched: exactly Block A, B, C at the root
// and nothing else. Anything the user drew is not it and is left alone.
export function isExampleDiagram(project) {
  const root = project.rootBlock.children;
  if (!root || project.path.length) return false;
  const blocks = [...root.blocks.values()];
  if (blocks.length !== EXAMPLE_NAMES.length) return false;
  const names = blocks.map((b) => b.name).sort();
  return names.every((name, i) => name === EXAMPLE_NAMES[i]) && blocks.every((b) => !b.children || !b.children.blocks?.size);
}

export function findBoardByNodeId(project, nodeId) {
  if (!nodeId) return null;
  return collectBoardBlocks(project.rootBlock.children).find(({ block }) => propOf(block, 'nodeId') === nodeId)?.block || null;
}

function toRoot(project) {
  while (project.path.length) project.exitBlock();
}

// Opens the board so the canvas shows its inside — unless the view is
// already in it (or deeper inside it), which a reload keeps.
export function enterBoard(nodigraph, board) {
  if (nodigraph.project.path.includes(board.id)) return false;
  toRoot(nodigraph.project);
  if (typeof nodigraph.enterBlock === 'function') nodigraph.enterBlock(board.id);
  else nodigraph.project.enterBlock(board.id);
  return true;
}

async function placeBoard(nodigraph, info, { resolve = resolveModuleByName, place = addModuleBlock } = {}) {
  const name = moduleNameForBoard(info);
  if (!name) throw new Error(`no module for a board of type ${info.type}`);
  toRoot(nodigraph.project);
  if (isExampleDiagram(nodigraph.project)) {
    for (const block of [...nodigraph.project.rootBlock.children.blocks.values()]) nodigraph.project.removeBlock(block.id);
  }
  const { manifest, source } = await resolve(nodigraph, name);
  const board = place(nodigraph, manifest, source)[0];
  if (info.name && !/^esp32/i.test(info.name)) board.name = info.name;
  setProp(board, 'nodeId', info.node || '');
  setProp(board, 'nodeName', info.name || '');
  return board;
}

// Connects the block to the board this page came from, the way the
// reconnect card does, and settles it against the circuit the board holds.
// Never throws: a board that does not answer leaves its block honestly
// "Not connected", and the dialog's own Connect is still there.
async function connectBoard(nodigraph, board, host, deps) {
  const { flash = serialFlash, console_ = serialConsole, reconcile = reconcileWithDevice, neighbours = scanAndPlaceNeighbours, log = () => {} } = deps;
  setProp(board, 'connectionState', 'connecting');
  nodigraph.renderLoop.requestRender();
  try {
    await flash.connectWifi(board.id, host);
    const info = await console_.identify(board.id);
    setProp(board, 'connectionState', info.verified ? 'connected:running' : 'connected:unknown');
    if (info.node) setProp(board, 'nodeId', info.node);
    if (info.nodeName) setProp(board, 'nodeName', info.nodeName);
    if (info.verified) {
      try {
        info.reconcile = await reconcile(nodigraph, board);
        log(`${board.name}: ${info.reconcile.message}`);
      } catch (err) {
        log(`${board.name}: could not read the circuit on the device: ${err.message}`);
      }
      // What the board hears on its CAN bus, placed beside it and wired
      // (canNeighbours.js) — before the board is entered, while its level
      // is the one being edited. A CNC module on the bus is on the canvas
      // from the first look, online through the board.
      try {
        info.neighbours = await neighbours(nodigraph, board, { status: log });
        log(describeNeighbours(board.name, info.neighbours));
      } catch (err) {
        log(`${board.name}: its CAN neighbours could not be placed: ${err.message}`);
      }
    }
    return info;
  } catch (err) {
    console_.closeConsole(board.id);
    await flash.disconnect(board.id).catch(() => {});
    setProp(board, 'connectionState', 'disconnected');
    log(`${board.name}: could not connect to ${host}: ${err.message}`);
    return null;
  }
}

// Where the board keeps the project. nodigraph's store.js PUTs it to
// /api/project, which the firmware reads whole into RAM (WebServer's
// `plain` argument) — measured on the S3: 60 KB is taken, 120 KB drops
// the connection, and a project holding the S3 block is past that (the
// block's props and their description twice over). The board's file
// upload (/files, multipart) streams to flash instead, with no such
// limit, and lands in the same /project.json that GET /api/project
// serves. So on a board's page the shared write goes that way
// (window.nodigraphSaveProject, see store.js), batched: every edit
// persists, and a 100 KB write ties the board's one connection up for a
// moment each time, so autosaves wait `delayMs` after the last one and
// the newest wins; an explicit Save (flush) writes at once and reports
// whether the board took it. What is still pending when the page goes
// away is sent as a beacon.
export function installProjectStore({ fetchImpl = fetch, delayMs = 1500, target = typeof window !== 'undefined' ? window : globalThis } = {}) {
  let timer = null;
  let latest = null;
  let chain = Promise.resolve(true);
  const asForm = (data) => {
    const body = new FormData();
    body.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), 'project.json');
    return body;
  };
  const upload = async (data) => {
    const res = await fetchImpl('/files', { method: 'POST', body: asForm(data) });
    return Boolean(res.ok);
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const data = latest;
    latest = null;
    if (data) chain = chain.then(() => upload(data), () => upload(data)).catch(() => false);
    return chain;
  };
  const save = (data, { flush: now = false } = {}) => {
    latest = data;
    if (now) return flush();
    if (!timer) timer = setTimeout(flush, delayMs);
    return Promise.resolve(true);
  };
  target.nodigraphSaveProject = save;
  target.addEventListener?.('pagehide', () => {
    if (!latest) return;
    const data = latest;
    latest = null;
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) navigator.sendBeacon('/files', asForm(data));
  });
  return { save, flush, pending: () => latest !== null };
}

// Everything above, at boot. Resolves to null when this is not a board's
// page; otherwise to { board, info } with the block placed (or found),
// connected when the board answered, and entered.
// The host without the page's port: the WiFi link has a port of its own
// (the board's WebSocket on 81, see wifiTransport.js).
export async function installBoardPage(nodigraph, { host = window.location.hostname, fetchImpl = fetch, store = null, ...deps } = {}) {
  const who = await whoServesThisPage(fetchImpl);
  if (!who) return null;
  let board = findBoardByNodeId(nodigraph.project, who.node);
  if (!board) {
    try {
      board = await placeBoard(nodigraph, who, deps);
    } catch (err) {
      (deps.log || console.warn)(`[noditron] this board's page could not place its block: ${err.message}`);
      return null;
    }
  }
  const info = await connectBoard(nodigraph, board, host, deps);
  enterBoard(nodigraph, board);
  nodigraph.selection.clear?.();
  nodigraph.persist();
  nodigraph.renderLoop.requestRender();
  // The block is on the board's flash before anything else happens, so a
  // reload straight away already finds it.
  if (store) await store.flush();
  return { board, info };
}
