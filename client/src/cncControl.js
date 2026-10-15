// The CNC control: the machine panel (cncPanel.js), a gcode editor that
// streams its program to grbl, and the files — what the old CNC firmware's
// own page offered, rebuilt on the board's shell so it works over any link.
//
// Files: M1-M4 are the board's macros (`cnc macro read|write|run <n>`,
// grbl's User/Macro1-4 settings), which the machine runs by itself — a
// joystick button sends `macro run <n>` over the bus. A macro is one line
// of gcode with `;` between commands and grbl's 256-byte line around it, so
// it holds a short program (MACRO_MAX). A longer one lives in the editor
// (kept on the board block, see `program` below) and in files on this
// computer (Open / Save).
//
// Running streams the editor line by line as `cnc <line>`: each waits for
// grbl's ok, so grbl's own buffer is the flow control. A line grbl takes
// but answers late (its planner full behind a long move) comes back as the
// board's "no answer from grbl" — taken, and the next one follows; a full
// input is retried; an error stops the run at that line. Pause is grbl's
// feed hold (`stop`), Resume its cycle start, Stop ends in Idle (`unlock`:
// hold, wait for standstill, reset — the position is kept).
//
//   mountCncControl(target, { shell, isLinked, isBusy, program, saveProgram })
//
// `program` is the editor's text at open; `saveProgram(text)` keeps it.

import { mountCncPanel } from './cncPanel.js';

export const MACRO_MAX = 230;
const MACROS = [1, 2, 3, 4];

// The lines grbl is sent: comments — `( ... )` and from `;` on — and
// blank lines dropped, each with the editor line it came from.
export function programLines(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
    if (line && line !== '%') out.push({ line, index });
  });
  return out;
}

// A program as one macro line, or null when it does not fit.
export function macroText(text) {
  const joined = programLines(text).map((l) => l.line).join('; ');
  return joined.length <= MACRO_MAX ? joined : null;
}

// A macro as the editor shows it: one command per line.
export function macroToProgram(text) {
  return String(text || '').split(';').map((s) => s.trim()).filter(Boolean).join('\n');
}

// What a streamed line's reply means for the run.
export function lineOutcome(reply) {
  if (reply?.ok) return 'next';
  const error = String(reply?.error || '');
  if (/no answer from grbl/i.test(error)) return 'next';
  if (/input is full/i.test(error)) return 'retry';
  return 'error';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, title) {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

const TABS = [['control', 'Control'], ['program', 'Program'], ['files', 'Files']];

// Laid out as a small app (classes cnc-app-*, styled in styles.css): the
// machine's state and position in a header that stays put, then Control
// (actions, jog pad, a gcode line), Program (the editor and its run) and
// Files (the macros) — on a phone one at a time behind a tab bar at the
// bottom, the window filling the screen; on a desktop side by side.
export function mountCncControl(target, { shell, isLinked = () => true, isBusy = () => false, program = '', saveProgram = () => {}, title = 'CNC', tab = 'control' } = {}) {
  const app = el('div', 'cnc-app');
  app.dataset.tab = tab;
  target.appendChild(app);

  const header = el('div', 'cnc-app-head');
  header.appendChild(el('div', 'cnc-app-title', title));
  app.appendChild(header);

  const sections = {};
  const main = el('div', 'cnc-app-main');
  app.appendChild(main);
  for (const [key, label] of TABS) {
    const section = el('section', 'cnc-app-section');
    section.dataset.tab = key;
    section.appendChild(el('h4', 'cnc-app-label', label));
    sections[key] = section;
  }
  // Desktop order: the program and its files beside the machine.
  const side = el('div', 'cnc-app-side');
  side.append(sections.program, sections.files);
  main.append(sections.control, side);

  const statusEl = el('div', 'cnc-app-status');
  app.appendChild(statusEl);
  const say = (text) => { statusEl.textContent = text; };

  const tabs = el('nav', 'cnc-app-tabs');
  const tabButtons = {};
  for (const [key, label] of TABS) {
    const b = button(label, 'cnc-app-tab');
    b.dataset.tab = key;
    b.addEventListener('click', () => show(key));
    tabButtons[key] = b;
    tabs.appendChild(b);
  }
  app.appendChild(tabs);
  function show(key) {
    app.dataset.tab = key;
    for (const [k, b] of Object.entries(tabButtons)) b.classList.toggle('cnc-active', k === key);
  }
  show(tab);

  // ── The machine ──
  const stopPanel = mountCncPanel(sections.control, { shell, isLinked, isBusy, headTarget: header });

  // ── The editor ──
  const toolbar = el('div', 'cnc-toolbar');
  const runBtn = button('Run', 'cnc-btn cnc-primary', 'Stream the program to the machine');
  const pauseBtn = button('Pause', 'cnc-btn', 'Feed hold');
  const stopBtn = button('Stop', 'cnc-btn cnc-warn', 'End the run: hold, then back to Idle (the position is kept)');
  const openBtn = button('Open\u2026', 'cnc-btn', 'Load a gcode file from this device');
  const saveBtn = button('Save\u2026', 'cnc-btn', 'Save the program to a file on this device');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.nc,.gcode,.gc,.g,.ngc,.tap,.txt';
  fileInput.hidden = true;
  toolbar.append(runBtn, pauseBtn, stopBtn, el('span', 'cnc-spacer'), openBtn, saveBtn, fileInput);
  sections.program.appendChild(toolbar);
  const editor = el('textarea', 'cnc-editor');
  editor.spellcheck = false;
  editor.autocapitalize = 'characters';
  editor.autocomplete = 'off';
  editor.placeholder = 'G21 G90\nG0 X0 Y0\nG1 X20 F800\n...';
  editor.value = program || '';
  sections.program.appendChild(editor);
  const runStatus = el('div', 'cnc-run-status');
  sections.program.appendChild(runStatus);
  const progress = (text) => { runStatus.textContent = text; say(text); };

  // ── The files: the board's macros ──
  const macroList = el('div', 'cnc-macros');
  sections.files.appendChild(macroList);
  sections.files.appendChild(el('div', 'cnc-note', `M1-M4 are the machine's macros: it runs them by itself (a button on the bus sends macro run <n>). One line each, up to ${MACRO_MAX} characters of gcode. Longer programs: Program, Open / Save.`));

  let saveTimer = null;
  editor.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProgram(editor.value), 800);
  });

  openBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    editor.value = await file.text();
    saveProgram(editor.value);
    progress(`Opened ${file.name} (${programLines(editor.value).length} lines).`);
    fileInput.value = '';
  });
  saveBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([editor.value], { type: 'text/plain' }));
    a.download = 'program.nc';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ── Streaming ──
  let run = null; // { paused, stopped }
  function setRunning(on) {
    runBtn.disabled = on;
    tabButtons.program.classList.toggle('cnc-running', on);
    editor.readOnly = on;
    pauseBtn.textContent = 'Pause';
  }
  function highlight(index) {
    const lines = editor.value.split('\n');
    let start = 0;
    for (let i = 0; i < index; i++) start += lines[i].length + 1;
    editor.setSelectionRange(start, start + (lines[index] || '').length);
  }

  runBtn.addEventListener('click', async () => {
    if (run || !isLinked()) {
      if (!isLinked()) progress('Not connected.');
      return;
    }
    const lines = programLines(editor.value);
    if (!lines.length) { progress('Nothing to run.'); return; }
    const job = { paused: false, stopped: false };
    run = job;
    setRunning(true);
    let i = 0;
    try {
      while (i < lines.length && !job.stopped) {
        if (job.paused) { await new Promise((r) => setTimeout(r, 150)); continue; }
        const { line, index } = lines[i];
        highlight(index);
        progress(`line ${i + 1}/${lines.length}: ${line}`);
        const reply = await shell(`cnc ${line}`, { timeoutMs: 5000 }).catch((err) => ({ ok: false, error: err.message }));
        const outcome = lineOutcome(reply);
        if (outcome === 'retry') { await new Promise((r) => setTimeout(r, 200)); continue; }
        if (outcome === 'error') {
          progress(`Stopped at line ${index + 1} (${line}): ${reply.error || 'no answer'}`);
          job.stopped = true;
          break;
        }
        i += 1;
      }
      if (i >= lines.length) progress(`Sent all ${lines.length} lines; the machine finishes what it has queued.`);
      else if (job.stopped && !/^Stopped at/.test(runStatus.textContent)) progress(`Stopped after line ${i}/${lines.length}.`);
    } finally {
      if (run === job) run = null;
      setRunning(false);
    }
  });
  pauseBtn.addEventListener('click', async () => {
    if (!run) { await shell('cnc start', {}).catch(() => {}); return; }
    run.paused = !run.paused;
    pauseBtn.textContent = run.paused ? 'Resume' : 'Pause';
    await shell(run.paused ? 'cnc stop' : 'cnc start', {}).catch(() => {});
  });
  stopBtn.addEventListener('click', async () => {
    if (run) run.stopped = true;
    await shell('cnc unlock', { timeoutMs: 5000 }).catch(() => {});
  });

  // ── Macros ──
  const macroCells = new Map();
  for (const n of MACROS) {
    const row = el('div', 'cnc-macro');
    const name = el('span', 'cnc-macro-name', `M${n}`);
    const preview = el('span', 'cnc-macro-text', '...');
    const loadBtn = button('Edit', 'cnc-btn', `Load M${n} into the editor`);
    const writeBtn = button('Save', 'cnc-btn', `Store the editor as M${n} on the board`);
    const runOne = button('Run', 'cnc-btn cnc-primary', `The machine runs M${n} by itself`);
    row.append(name, preview, loadBtn, writeBtn, runOne);
    macroList.appendChild(row);
    macroCells.set(n, preview);
    loadBtn.addEventListener('click', async () => {
      const reply = await shell(`cnc macro read ${n}`, {}).catch((err) => ({ ok: false, error: err.message }));
      if (!reply.ok) { progress(`M${n}: ${reply.error || 'no answer'}`); return; }
      editor.value = macroToProgram((reply.lines || []).join(';'));
      saveProgram(editor.value);
      progress(`M${n} loaded into the program.`);
      show('program');
    });
    writeBtn.addEventListener('click', async () => {
      const text = macroText(editor.value);
      if (text === null) { progress(`Too long for a macro: ${MACRO_MAX} characters at most once comments are dropped.`); return; }
      const reply = await shell(`cnc macro write ${n} ${text}`, {}).catch((err) => ({ ok: false, error: err.message }));
      progress(reply.ok ? `Saved as M${n} on the board.` : `M${n}: ${reply.error || 'no answer'}`);
      refreshMacros();
    });
    runOne.addEventListener('click', async () => {
      const reply = await shell(`cnc macro run ${n}`, {}).catch((err) => ({ ok: false, error: err.message }));
      progress(reply.ok ? `M${n} running on the machine.` : `M${n}: ${reply.error || 'no answer'}`);
    });
  }
  async function refreshMacros() {
    if (!isLinked() || isBusy()) return;
    const reply = await shell('cnc macro', { quiet: true }).catch(() => null);
    if (!reply?.ok) return;
    for (const text of reply.lines || []) {
      const m = text.match(/^(\d)\s?(.*)$/);
      const cell = m && macroCells.get(Number(m[1]));
      if (cell) {
        cell.textContent = m[2].trim() || '(empty)';
        cell.title = m[2].trim();
      }
    }
  }
  refreshMacros();

  return () => {
    if (run) run.stopped = true;
    clearTimeout(saveTimer);
    saveProgram(editor.value);
    stopPanel();
  };
}
