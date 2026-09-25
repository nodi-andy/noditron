#!/usr/bin/env node
// Builds modules/esp32-cnc/noditron.module.json — the CNC module block.
//
//   node tools/build-esp32-cnc-module.mjs
//
// A CNC module is conucon's esp32_cnc firmware: grbl as the core, with the
// same module layer around it the Logic Module has (identity, shell, node
// table, radios — see its Grbl_Esp32/src/Module.cpp). On the canvas it is
// one block with a `gcode` input: whatever arrives there is sent to the
// machine as `g <line>` through the board's shell (see main.js). The
// dialog is the same Connect / Connectivity / Shell the esp32-S3 has,
// with the machine's own controls in place of a circuit section; the
// Connectivity and Shell code is taken from the S3 manifest so the two
// never drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(here, '..', 'modules', 'esp32-cnc', 'noditron.module.json');
const S3_PATH = path.join(here, '..', 'modules', 'esp32-s3-devkit', 'noditron.module.json');

const s3 = JSON.parse(fs.readFileSync(S3_PATH, 'utf8'));
const s3Block = s3.block.blocks[0];
const s3Dialog = s3Block.props.find((p) => p.name === 'dialog').value;
const s3Html = s3Block.props.find((p) => p.name === 'html').value;

// The Connectivity + Shell sections, verbatim from the S3 dialog.
const secStart = s3Dialog.indexOf('  // ── Connectivity: who is around');
// ...up to the S3's own circuit helpers that follow them.
const secEnd = s3Dialog.indexOf('  function updateProgramSection() {');
if (secStart < 0 || secEnd < 0) throw new Error('the S3 dialog no longer carries the Connectivity/Shell sections where this expects them');
const SECTIONS = s3Dialog.slice(secStart, secEnd);

const STATUS_HTML = s3Html
  .replace("text = dirty ? 'Running \\u00b7 circuit not saved' : 'Logic Module running';", "text = 'grbl running';")
  .replace('const dirty = helpers.devkit.dirty ? helpers.devkit.dirty() : false;', 'const dirty = false;')
  .replace("hint = dirty ? 'Save the circuit to the device' : 'Connected';", "hint = 'Connected';");
if (!STATUS_HTML.includes("'grbl running'")) throw new Error('the S3 html no longer has the running text this adapts');

const RENDER = `
const g = block.geometry;
ctx.save();
ctx.fillStyle = '#ffffff';
ctx.fillRect(g.x + 12, g.y + 8, g.width - 24, g.height - 16);
ctx.fillStyle = '#1f2937';
ctx.font = '18px -apple-system, Segoe UI, Roboto, sans-serif';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText(block.name || 'cnc', g.x + g.width / 2, g.y + g.height / 2 - 6, g.width - 48);
ctx.fillStyle = '#6b7280';
ctx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
ctx.fillText('grbl', g.x + g.width / 2, g.y + g.height / 2 + 14);
ctx.fillStyle = '#1f2937';
ctx.font = '13px -apple-system, Segoe UI, Roboto, sans-serif';
ctx.textAlign = 'left';
ctx.fillText('gcode', g.x + 26, g.y + 30);
ctx.restore();
`.trim();

const DIALOG = `
container.style.fontFamily = 'Inter, sans-serif';
container.style.minWidth = '420px';

const heading = document.createElement('h3');
heading.textContent = String(block.name || 'CNC').toUpperCase();
heading.style.cssText = 'margin:0 0 14px;color:var(--success,#3ecf5d);font-size:15px;letter-spacing:.03em;';
container.appendChild(heading);

{
  const btnStyle = 'padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text-primary);font-size:12px;cursor:pointer;';
  const primaryBtnStyle = 'padding:6px 14px;border:1px solid var(--success,#3ecf5d);border-radius:6px;background:var(--success,#3ecf5d);color:#06210f;font-size:12px;font-weight:600;cursor:pointer;';
  const sectionStyle = 'margin:0 0 16px;padding-bottom:16px;border-bottom:1px solid var(--border);';
  const labelStyle = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin-bottom:8px;';
  const serialOk = helpers.serial && helpers.serial.isSupported();

  const statusEl = document.createElement('p');
  statusEl.style.cssText = 'margin:0 0 12px;font-size:12px;color:var(--text-muted);';
  container.appendChild(statusEl);

  const connectRow = document.createElement('div');
  connectRow.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';
  const connectBtn = document.createElement('button');
  connectBtn.type = 'button';
  connectBtn.textContent = 'Connect (COM)';
  connectBtn.style.cssText = btnStyle;
  connectBtn.disabled = !serialOk;
  connectBtn.title = serialOk ? '' : 'Web Serial is not available in this browser (Chrome or Edge on desktop)';
  const wifiBtn = document.createElement('button');
  wifiBtn.type = 'button';
  wifiBtn.textContent = 'Connect (WiFi)';
  wifiBtn.style.cssText = btnStyle;
  const disconnectBtn = document.createElement('button');
  disconnectBtn.type = 'button';
  disconnectBtn.textContent = 'Disconnect';
  disconnectBtn.style.cssText = btnStyle;
  disconnectBtn.disabled = true;
  connectRow.append(connectBtn, wifiBtn, disconnectBtn);
  container.appendChild(connectRow);

  // ── The machine: the CNC module's own web page, which already has the
  // status, jog, start/stop and file controls — shown inside the dialog
  // once the board says where it can be reached. This browser has to be
  // on the same network as that address (the board's own access point, or
  // the network it joined).
  const machineSection = document.createElement('div');
  machineSection.style.cssText = sectionStyle + 'display:none;';
  const machineHeader = document.createElement('div');
  machineHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;';
  const machineLabel = document.createElement('div');
  machineLabel.textContent = 'MACHINE';
  machineLabel.style.cssText = labelStyle + 'margin-bottom:0;';
  const machineState = document.createElement('span');
  machineState.style.cssText = 'font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--text-secondary);flex:1;';
  machineState.textContent = 'state ?';
  const machineOpen = document.createElement('a');
  machineOpen.textContent = 'Open in a tab';
  machineOpen.target = '_blank';
  machineOpen.rel = 'noopener';
  machineOpen.style.cssText = 'font-size:11px;color:var(--text-muted);';
  const machineReload = document.createElement('button');
  machineReload.type = 'button';
  machineReload.textContent = 'Reload';
  machineReload.style.cssText = btnStyle + 'padding:3px 10px;font-size:11px;';
  machineHeader.append(machineLabel, machineState, machineOpen, machineReload);
  machineSection.appendChild(machineHeader);
  const machineFrame = document.createElement('iframe');
  machineFrame.style.cssText = 'width:100%;height:520px;border:1px solid var(--border);border-radius:6px;background:#0d1117;';
  machineFrame.setAttribute('title', 'CNC module page');
  machineSection.appendChild(machineFrame);
  const machineHint = document.createElement('div');
  machineHint.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:6px;';
  machineSection.appendChild(machineHint);
  container.appendChild(machineSection);
  // The page needs room: widen this dialog's panel while it is open.
  const panel = container.closest('.noditron-dialog-panel');
  if (panel) panel.style.maxWidth = 'min(960px, calc(100vw - 32px))';
  let machineUrl = '';
  function showMachinePage(ip) {
    if (!ip || ip === '-' || ip === '0.0.0.0') {
      machineFrame.style.display = 'none';
      machineOpen.style.display = 'none';
      machineHint.textContent = 'The board has no network address yet -- turn on its access point or join a network below, then Reload.';
      return;
    }
    machineUrl = 'http://' + ip + '/';
    machineFrame.style.display = '';
    machineOpen.style.display = '';
    machineOpen.href = machineUrl;
    machineFrame.src = machineUrl;
    machineHint.textContent = 'The module\\'s own page at ' + machineUrl + ' -- reachable when this computer is on that network (its access point, or the network it joined). Gcode also goes through the shell below as g <line>, and from the block\\'s gcode input.';
  }
  machineReload.addEventListener('click', async () => {
    try {
      const info = await helpers.console.identify();
      showMachinePage(info.ip);
    } catch (err) {
      machineHint.textContent = err.message;
    }
  });
  // grbl reports its state on its own lines ([MSG:State: Idle], <Idle|...>),
  // usually after the shell's ok; read them as they arrive.
  if (helpers.console.subscribeLines) {
    const stopState = helpers.console.subscribeLines(({ line }) => {
      if (!container.isConnected) { stopState(); return; }
      const msg = line.match(/^\\[MSG:State: (\\w+)\\]/);
      const report = line.match(/^<(\\w+)[|>]/);
      if (msg) machineState.textContent = 'state ' + msg[1];
      else if (report) machineState.textContent = 'state ' + report[1];
    });
  }

${SECTIONS}
  container.appendChild(shellSection);
  function log(line) {
    shellPrint(line);
  }

  function showRunning(info) {
    statusEl.textContent = 'grbl v' + info.version + ' build ' + info.build + ' running.';
    machineState.textContent = 'state ' + (info.machineState || '?');
    machineSection.style.display = '';
    showMachinePage(info.ip);
    startConnectivity();
  }

  async function afterPortOpen() {
    statusEl.textContent = 'Connected -- asking who is there...';
    try {
      const info = await helpers.console.identify();
      if (info.verified && info.kind === 'cnc') {
        log('ping: grbl v' + info.version + ' build ' + info.build + ', state ' + (info.machineState || '?') + '.');
        helpers.setProp('connectionState', 'connected:running');
        showRunning(info);
        return;
      }
      if (info.verified) {
        statusEl.textContent = 'That is a Logic Module, not a CNC module.';
        log('ping answered as a Logic Module (build ' + info.build + ').');
        helpers.setProp('connectionState', 'connected:unknown');
        return;
      }
      statusEl.textContent = 'Connected, but nothing answered as a CNC module. Its firmware may predate the module shell (build 20260925a).';
      helpers.setProp('connectionState', 'connected:unknown');
    } catch (err) {
      statusEl.textContent = 'Connected, but could not identify the board: ' + err.message;
      helpers.setProp('connectionState', 'connected:unknown');
    }
  }

  const existing = helpers.serial.getSession();
  if (existing) {
    disconnectBtn.disabled = false;
    connectBtn.disabled = true;
    wifiBtn.disabled = true;
    afterPortOpen();
  } else {
    statusEl.textContent = 'Not connected.';
  }

  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    wifiBtn.disabled = true;
    try {
      await helpers.serial.connect(log);
      log('Serial port opened.');
      disconnectBtn.disabled = false;
      await afterPortOpen();
    } catch (err) {
      statusEl.textContent = 'Connect failed: ' + err.message;
      connectBtn.disabled = !serialOk;
      wifiBtn.disabled = false;
    }
  });

  wifiBtn.addEventListener('click', async () => {
    if (!helpers.serial.connectWifi) { log('This noditron has no WiFi link yet.'); return; }
    const last = (helpers.serial.rememberedWifi && helpers.serial.rememberedWifi()) || '192.168.0.1';
    const host = window.prompt('Board address: its IP or name on your network, or 192.168.0.1 on its own access point.', last);
    if (!host) return;
    wifiBtn.disabled = true;
    connectBtn.disabled = true;
    try {
      await helpers.serial.connectWifi(host, log);
      disconnectBtn.disabled = false;
      await afterPortOpen();
    } catch (err) {
      statusEl.textContent = 'WiFi connect failed: ' + err.message;
      log('WiFi connect failed: ' + err.message);
      wifiBtn.disabled = false;
      connectBtn.disabled = !serialOk;
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    helpers.console.close();
    await helpers.serial.disconnect(true);
    statusEl.textContent = 'Disconnected.';
    connectBtn.disabled = !serialOk;
    wifiBtn.disabled = false;
    disconnectBtn.disabled = true;
    machineSection.style.display = 'none';
    netSection.style.display = 'none';
    helpers.setProp('connectionState', 'disconnected');
  });
}
`.trim();

const block = {
  id: 'blk_esp32cnc_1',
  name: 'cnc',
  type: 'block',
  kind: 'block',
  description: '',
  geometry: { x: 0, y: 0, width: 220, height: 120 },
  style: { color: '#7c3aed' },
  logicalPorts: [
    { id: 'io_esp32cnc_gcode', name: 'gcode', direction: 'in', description: 'gcode lines for grbl, sent as g <line> through the module shell' },
  ],
  ports: [
    { id: 'prt_esp32cnc_gcode', logicalId: 'io_esp32cnc_gcode', side: 'left', offset: 30, manualOffset: true },
  ],
  props: [
    { id: 'prp_esp32cnc_kind', name: 'noditronKind', kind: 'value', value: 'cnc-module' },
    { id: 'prp_esp32cnc_chip', name: 'chipFamily', kind: 'value', value: 'ESP32' },
    { id: 'prp_esp32cnc_state', name: 'connectionState', kind: 'value', value: 'disconnected' },
    { id: 'prp_esp32cnc_html', name: 'html', kind: 'value', value: STATUS_HTML },
    { id: 'prp_esp32cnc_dialog', name: 'dialog', kind: 'value', value: DIALOG },
    { id: 'prp_esp32cnc_render', name: 'render', kind: 'value', value: RENDER },
    { id: 'prp_esp32cnc_children', name: 'allowedChildKinds', kind: 'value', value: '[]' },
  ],
  hasChildren: false,
  requirementIds: [],
};

const manifest = {
  noditronModule: 1,
  name: 'esp32-cnc',
  displayName: 'cnc',
  version: '0.1.0',
  description: "conucon's CNC module (grbl core): a gcode input sent to the machine through the board's shell, over USB or WiFi; Connectivity and Shell like the esp32-S3.",
  swatchColor: '#7c3aed',
  block: { format: 'nodigraph/clipboard-v1', blocks: [block], connections: [] },
};

fs.mkdirSync(path.dirname(MODULE_PATH), { recursive: true });
fs.writeFileSync(MODULE_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
new Function('container', 'block', 'props', 'outputs', 'helpers', DIALOG);
new Function('container', 'block', 'inputs', 'outputs', 'helpers', STATUS_HTML);
new Function('ctx', 'block', 'inputs', 'outputs', 'helpers', RENDER);
console.log(`esp32-cnc: written, dialog ${DIALOG.length} chars (sections ${SECTIONS.length} from the S3 manifest)`);
