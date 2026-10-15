#!/usr/bin/env node
// Builds modules/esp32-cnc/noditron.module.json — the CNC module block.
//
//   node tools/build-esp32-cnc-module.mjs
//
// A CNC module is conucon's esp32_cnc firmware: grbl as the core, with the
// same module layer around it the Logic Module has (identity, shell, node
// table, radios — see its Grbl_Esp32/src/Module.cpp). On the canvas it is
// one block with a `socket` port — its shell as a wire (see
// client/src/socketLink.js): in by default, so whatever arrives is written
// to the shell line by line; flipped to out it carries what grbl says. The
// dialog is the same Connect / Connectivity / Shell the esp32-S3 has,
// with the machine's own controls in place of a circuit section and a
// Firmware section that installs the bundled CNC build; the Connectivity
// and Shell code is taken from the S3 manifest so the two never drift
// apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// One module per board the CNC firmware is built for (see conucon's
// modules/esp32_cnc/platformio.ini and Machines/): the same block, with
// the board's own chip family and CAN pins.
const BOARDS = [
  { id: 'esp32-devkit', displayName: 'ESP32 DevKit \u00b7 CNC', chipFamily: 'ESP32', can: 'TX GPIO22 / RX GPIO23', boardVariant: 'ESP32 DevKit V1' },
  { id: 'esp32s3-2io', displayName: 'esp32-S3 2IO \u00b7 CNC', chipFamily: 'ESP32-S3', can: 'TX GPIO15 / RX GPIO16', boardVariant: 'ESP32-S3-RS485-CAN (2 IO)' },
  { id: 'esp32s3-8io', displayName: 'esp32-S3 8IO \u00b7 CNC', chipFamily: 'ESP32-S3', can: 'TX GPIO2 / RX GPIO3', boardVariant: 'ESP32-S3-POE-ETH-8DI-8DO' },
];
const modulePathFor = (board) => path.join(here, '..', 'modules', `${board.id}-cnc`, 'noditron.module.json');
const S3_PATH = path.join(here, '..', 'modules', 'esp32s3-8io-logic', 'noditron.module.json');

const s3 = JSON.parse(fs.readFileSync(S3_PATH, 'utf8'));
const s3Block = s3.block.blocks[0];
const s3Dialog = s3Block.props.find((p) => p.name === 'dialog').value;
const s3Html = s3Block.props.find((p) => p.name === 'html').value;

// The Connectivity + Shell sections, verbatim from the S3 dialog.
const secStart = s3Dialog.indexOf('  // ── Connectivity: who is around');
// ...up to the S3's own circuit helpers that follow them.
const secEnd = s3Dialog.indexOf('  function updateProgramSection() {');
if (secStart < 0 || secEnd < 0) throw new Error('the S3 dialog no longer carries the Connectivity/Shell sections where this expects them');
const SECTIONS = s3Dialog.slice(secStart, secEnd)
  // One radio at a time on this board (grbl's WiFi: station or access
  // point, never both), so the two switches are one choice: radio buttons
  // in place of the S3's independent checkboxes. The handlers are the
  // S3's own — a radio only ever fires `change` when it becomes checked,
  // which is exactly the `ap on` / `wifi on` branch of each — and the
  // status refresh sets `checked` on whichever `wifi status` reports on.
  .replace("box.type = 'checkbox';", "box.type = 'radio';\n    box.name = 'cnc-radio';")
  // A firmware install owns the port; the 10s connectivity poll must not
  // reach for the console while one runs (serialConsole throws if it tries,
  // but skipping keeps the hint quiet). serialFlash.isFlashing is the guard.
  .replace(
    "    if (netBusy || !container.isConnected) return;",
    "    if (netBusy || !container.isConnected) return;\n    if (helpers.serial.isFlashing && helpers.serial.isFlashing()) return;",
  );
if (!SECTIONS.includes("box.name = 'cnc-radio'")) throw new Error('the S3 connectivity section no longer has the checkbox line this adapts');
if (!SECTIONS.includes('helpers.serial.isFlashing()')) throw new Error('the S3 connectivity section no longer has the refreshConnectivity guard line this adapts');

const STATUS_HTML = s3Html
  .replace("text = dirty ? 'Running \\u00b7 circuit not saved' : 'Logic Module running';", "text = 'grbl running';")
  .replace('const dirty = helpers.devkit.dirty ? helpers.devkit.dirty() : false;', 'const dirty = false;')
  .replace("hint = dirty ? 'Save the circuit to the device' : 'Connected';", "hint = 'Connected';")
  .replace("hint = 'Install the Logic Module firmware';", "hint = 'Install the CNC firmware';");
if (!STATUS_HTML.includes("'grbl running'") || !STATUS_HTML.includes("'Install the CNC firmware'")) throw new Error('the S3 html no longer has the running/needs-firmware text this adapts');

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
ctx.fillText('socket', g.x + 26, g.y + 30);
ctx.textAlign = 'right';
ctx.fillText('CAN', g.x + g.width - 26, g.y + 30);
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

  // ── Firmware: the bundled CNC build for this board (every board the
  // CNC firmware is built for ships one, see serialFlash's
  // FIRMWARE_PRESETS). Over USB the files go through the ROM bootloader;
  // over WiFi the app image goes to the board's own update endpoint; over
  // CAN nothing can be written. Shown whenever a link is open: a board
  // that answered nothing needs it, a running one can take an update.
  const firmwareSection = document.createElement('div');
  firmwareSection.style.cssText = sectionStyle + 'display:none;';
  const firmwareLabel = document.createElement('div');
  firmwareLabel.textContent = 'FIRMWARE';
  firmwareLabel.style.cssText = labelStyle;
  firmwareSection.appendChild(firmwareLabel);
  const firmwareHint = document.createElement('p');
  firmwareHint.style.cssText = 'margin:0 0 10px;font-size:11px;color:var(--text-muted);';
  firmwareSection.appendChild(firmwareHint);
  const inputStyle = 'padding:5px 6px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:12px;';
  const presets = (helpers.serial.firmwarePresets || []).filter((p) => /^noditron-/.test(p.id) && (p.board === props.boardId || (!p.board && p.chip === props.chipFamily)));
  const preferredPreset = presets.find((p) => p.id === props.firmwarePreset) || presets[0] || null;
  const presetRow = document.createElement('div');
  presetRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;';
  const firmwareSelect = document.createElement('select');
  firmwareSelect.style.cssText = inputStyle + 'flex:1;min-width:0;';
  for (const preset of presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label + (preset.build ? ' (build ' + preset.build + ')' : '');
    firmwareSelect.appendChild(option);
  }
  if (preferredPreset) firmwareSelect.value = preferredPreset.id;
  if (!presets.length) {
    firmwareSelect.disabled = true;
    const none = document.createElement('option');
    none.textContent = 'No CNC firmware bundled for ' + (props.boardVariant || props.chipFamily || 'this board');
    firmwareSelect.appendChild(none);
  }
  const installBtn = document.createElement('button');
  installBtn.type = 'button';
  installBtn.textContent = 'Install firmware';
  installBtn.style.cssText = primaryBtnStyle;
  installBtn.disabled = !presets.length;
  presetRow.append(firmwareSelect, installBtn);
  firmwareSection.appendChild(presetRow);
  const progressEl = document.createElement('div');
  progressEl.style.cssText = 'margin:8px 0 0;font-size:11px;color:var(--text-muted);';
  firmwareSection.appendChild(progressEl);
  container.appendChild(firmwareSection);

  // What the section says, from what answered: 'running' (a CNC module,
  // maybe older than the bundled build), 'logic' (a Logic Module, which
  // the CNC build replaces), or 'none' (nothing answered).
  function showFirmware(state, info) {
    const link = helpers.serial.linkKind();
    firmwareSection.style.display = '';
    installBtn.disabled = link === 'can' || !presets.length;
    if (state === 'running') {
      const update = Boolean(preferredPreset && preferredPreset.build && info && info.build && info.build < preferredPreset.build);
      firmwareLabel.textContent = update ? 'FIRMWARE UPDATE AVAILABLE' : 'FIRMWARE';
      installBtn.textContent = update ? 'Update firmware' : 'Reinstall firmware';
      firmwareHint.textContent = 'Build ' + ((info && info.build) || '?') + ' installed' + (update ? ', build ' + preferredPreset.build + ' bundled.' : '.');
    } else {
      firmwareLabel.textContent = state === 'logic' ? 'LOGIC MODULE FIRMWARE INSTALLED' : 'NO CNC FIRMWARE DETECTED';
      installBtn.textContent = 'Install firmware';
      firmwareHint.textContent = (state === 'logic' ? 'The CNC build replaces it. ' : '') + 'Install the bundled CNC build for this board.';
    }
    if (link === 'can') firmwareHint.textContent = 'Firmware cannot be written over CAN -- connect this board over USB (or WiFi) to install.';
    else if (link === 'wifi') firmwareHint.textContent += ' Over WiFi the app image goes to the board\\'s own update endpoint; a blank board needs USB.';
  }

  async function installFiles(files) {
    const button = installBtn;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Installing...';
    try {
      await helpers.serial.flash(
        files,
        false,
        (fileIndex, written, total) => {
          progressEl.textContent = 'File ' + (fileIndex + 1) + '/' + files.length + ': ' + Math.round((written / total) * 100) + '%';
        },
        log,
      );
      progressEl.textContent = '';
      statusEl.textContent = 'Flashed -- waiting for the board to boot...';
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await afterPortOpen();
    } catch (err) {
      progressEl.textContent = '';
      statusEl.textContent = 'Install failed: ' + err.message;
      log('Install failed: ' + err.message);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }
  installBtn.addEventListener('click', async () => {
    const preset = presets.find((p) => p.id === firmwareSelect.value);
    if (!preset) return;
    installBtn.disabled = true;
    let files;
    try {
      // Every part of the preset together -- bootloader and partition
      // table included, a harmless rewrite on a board that has them and
      // the only way a blank chip ever boots (see the S3 dialog).
      files = await helpers.serial.fetchPresetParts(preset);
      log('Fetched ' + preset.label + ' (' + files.map((f) => f.name).join(', ') + ').');
    } catch (err) {
      log('Could not fetch ' + preset.label + ': ' + err.message);
      installBtn.disabled = false;
      return;
    }
    await installFiles(files);
  });

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
    machineHint.textContent = 'The module\\'s own page at ' + machineUrl + ' -- reachable when this computer is on that network (its access point, or the network it joined). Gcode goes through the shell below as g <line>; the block\\'s socket port writes whatever reaches it to this same shell.';
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

  function reportIdentified(info) {
    if (info.kind === 'cnc') {
      log('ping: grbl v' + info.version + ' build ' + info.build + ', state ' + (info.machineState || '?') + '.');
      helpers.setProp('connectionState', 'connected:running');
      // Who this node is, for another board's socket to address (see
      // devkitCircuit's socketLinksFor).
      if (info.node) helpers.setProp('nodeId', info.node);
      if (info.nodeName) helpers.setProp('nodeName', info.nodeName);
      showRunning(info);
      showFirmware('running', info);
      return;
    }
    statusEl.textContent = 'That is a Logic Module, not a CNC module -- install the CNC firmware below to make it one.';
    log('ping answered as a Logic Module (build ' + info.build + ').');
    helpers.setProp('connectionState', 'connected:unknown');
    showFirmware('logic', info);
  }

  // The one place that decides what is on the other end: the console's
  // own 'ping' first (harmless on a running board), and only when nothing
  // answers, over USB, the chip itself through its ROM bootloader -- that
  // tells a blank board from a dead link, and which family the firmware
  // has to be for. Reused after Connect and again after an install once
  // the board has had a moment to boot.
  async function afterPortOpen() {
    statusEl.textContent = 'Connected -- asking who is there...';
    const link = helpers.serial.linkKind();
    try {
      const info = await helpers.console.identify();
      if (info.verified) { reportIdentified(info); return; }
    } catch (err) {
      log('Console check failed: ' + err.message);
    }
    if (link === 'can') {
      statusEl.textContent = 'Reached over CAN through ' + ((helpers.serial.getSession() || {}).target || 'another board') + ', but it did not answer. Its firmware needs the node protocol (CNC build 20260927b or later): connect it over USB once to install.';
      helpers.setProp('connectionState', 'connected:unknown');
      showFirmware('none', null);
      return;
    }
    let chipName = '';
    if (link === 'serial') {
      try {
        const detected = await helpers.serial.detectChip(log);
        chipName = detected.chipName;
        log('Detected ' + detected.chipName + ' (bootloader @ 0x' + detected.bootloaderOffset.toString(16) + ').');
        // Detecting left the board in its ROM bootloader, not running
        // whatever it has; identify() resets it out (see serialFlash's
        // reopenPlain) and asks once more, so a board that only needed
        // longer to boot says so here instead of being reported as blank.
        try {
          const after = await helpers.console.identify();
          if (after.verified) { reportIdentified(after); return; }
        } catch (err) {
          log('Console re-check failed: ' + err.message);
        }
      } catch (err) {
        log('Chip detect failed: ' + err.message);
      }
    }
    statusEl.textContent = (chipName ? chipName + ' detected, but ' : 'Connected, but ') + 'nothing answered as a CNC module. Its firmware may predate the module shell (build 20260925a), or be missing -- install it below.';
    helpers.setProp('connectionState', chipName ? 'connected:needs-firmware:' + chipName : 'connected:unknown');
    showFirmware('none', null);
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
    firmwareSection.style.display = 'none';
    netSection.style.display = 'none';
    helpers.setProp('connectionState', 'disconnected');
  });
}
`.trim();

for (const board of BOARDS) {
  const block = {
    id: 'blk_esp32cnc_1',
    name: 'cnc',
    type: 'block',
    kind: 'block',
    description: '',
    geometry: { x: 0, y: 0, width: 220, height: 120 },
    style: { color: '#7c3aed' },
    logicalPorts: [
      { id: 'io_esp32cnc_socket', name: 'socket', direction: 'in', description: 'the module shell: in writes every line that arrives to it (g <line> for gcode), out carries every line grbl prints' },
      // The CAN bus the module sits on: the Add Block window wires it to a
      // Logic Module's CAN pin when either board hears the other (`nodes`,
      // via can) — the physical bus, drawn. Direction none, like the S3's.
      { id: 'io_esp32cnc_can', name: 'CAN', direction: null, description: `the CAN bus (${board.can}): wired to the other boards on the same bus` },
    ],
    ports: [
      { id: 'prt_esp32cnc_socket', logicalId: 'io_esp32cnc_socket', side: 'left', offset: 30, manualOffset: true },
      { id: 'prt_esp32cnc_can', logicalId: 'io_esp32cnc_can', side: 'right', offset: 30, manualOffset: true },
    ],
    props: [
      { id: 'prp_esp32cnc_kind', name: 'noditronKind', kind: 'value', value: 'cnc-module' },
      { id: 'prp_esp32cnc_chip', name: 'chipFamily', kind: 'value', value: board.chipFamily },
      { id: 'prp_esp32cnc_board', name: 'boardId', kind: 'value', value: board.id },
      { id: 'prp_esp32cnc_variant', name: 'boardVariant', kind: 'value', value: board.boardVariant },
      { id: 'prp_esp32cnc_preset', name: 'firmwarePreset', kind: 'value', value: `noditron-${board.id}` },
      { id: 'prp_esp32cnc_state', name: 'connectionState', kind: 'value', value: 'disconnected' },
      { id: 'prp_esp32cnc_html', name: 'html', kind: 'value', value: STATUS_HTML },
      { id: 'prp_esp32cnc_dialog', name: 'dialog', kind: 'value', value: DIALOG },
      { id: 'prp_esp32cnc_render', name: 'render', kind: 'value', value: RENDER },
      { id: 'prp_esp32cnc_children', name: 'allowedChildKinds', kind: 'value', value: '[]' },
      // Who this node is, from identify / `nodes` (see addBlockDialog.js and
      // devkitCircuit's socketLinksFor): declared so setProp has them.
      { id: 'prp_esp32cnc_node', name: 'nodeId', kind: 'value', value: '' },
      { id: 'prp_esp32cnc_nodename', name: 'nodeName', kind: 'value', value: '' },
    ],
    hasChildren: false,
    requirementIds: [],
  };

  const manifest = {
    noditronModule: 1,
    name: `${board.id}-cnc`,
    displayName: board.displayName,
    version: '0.6.0',
    description: "conucon's CNC module (grbl core): a socket port that is the board's shell as a wire, over USB or WiFi; firmware installation (the bundled build); Connectivity and Shell like the esp32-S3.",
    swatchColor: '#7c3aed',
    block: { format: 'nodigraph/clipboard-v1', blocks: [block], connections: [] },
  };

  fs.mkdirSync(path.dirname(modulePathFor(board)), { recursive: true });
  fs.writeFileSync(modulePathFor(board), `${JSON.stringify(manifest, null, 2)}\n`);
}
new Function('container', 'block', 'props', 'outputs', 'helpers', DIALOG);
new Function('container', 'block', 'inputs', 'outputs', 'helpers', STATUS_HTML);
new Function('ctx', 'block', 'inputs', 'outputs', 'helpers', RENDER);
console.log(`${BOARDS.map((b) => `${b.id}-cnc`).join(', ')}: written, dialog ${DIALOG.length} chars (sections ${SECTIONS.length} from the S3 manifest)`);
