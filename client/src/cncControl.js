// The CNC control: the machine panel (cncPanel.js), a gcode program that
// streams to grbl, the machine's files and a terminal — what the old CNC
// firmware's own page offered, rebuilt on the board's shell so it works
// over any link (USB, WiFi, a CAN hop through another board).
//
//   mountCncControl(target, { shell, isLinked, isBusy, program, saveProgram, settings })
//
// One header for everything: the title, the machine's state, its position
// and what went wrong, if anything; Files and Settings beside the title.
// Below it Control (the pad), Program (the editor) and Terminal — on a
// phone one at a time behind a tab bar, on a desktop side by side.
//
// The pad's Run starts the program (or resumes it after Hold), Hold is
// grbl's feed hold, Stop ends the run: hold, wait for standstill, reset to
// Idle with the position kept (`unlock`). Running streams the editor line
// by line as `cnc <line>`: each waits for grbl's ok, so grbl's own buffer
// is the flow control. A line grbl takes but answers late (its planner
// full behind a long move) comes back as the board's "no answer from
// grbl" — taken, and the next one follows; a full input is retried; an
// error stops the run at that line.
//
// Files: M1-M4 are the board's macros (`cnc macro read|write|run <n>`,
// grbl's User/Macro1-4 settings), which the machine runs by itself — a
// joystick button sends `macro run <n>` over the bus. A macro is one line
// of gcode with `;` between commands, so it holds a short program
// (MACRO_MAX); longer ones live in the editor and in files on this
// computer (Open / Save).
//
// Terminal: one line for everything typed — gcode and grbl's shell words
// (`help`, `ls`, `$$`, `?`) go to grbl as `cnc <line>`; a line starting
// with `@` goes to the board's own shell (`@log`, `@limit forget`). Every
// button's command and answer shows there too. Up and down walk what was
// typed; Copy takes the whole terminal.
//
// Settings (`settings`, see dialogSystem's cncSettingsFor): jog speed,
// homing speed and each axis' homing direction.

import { mountCncPanel } from './cncPanel.js';

export const MACRO_MAX = 230;
const MACROS = [1, 2, 3, 4];
const AXES = ['x', 'y', 'z', 'a', 'b', 'c'];
const TERMINAL_LINES = 500;

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

// What a line typed in the terminal is sent as: `@...` to the board's own
// shell, anything else to grbl.
export function terminalLine(text) {
  const line = String(text || '').trim();
  if (!line) return null;
  return line.startsWith('@') ? line.slice(1).trim() || null : `cnc ${line}`;
}

// A move typed without G0/G1 runs in the motion mode last set, and after a
// reset that is G0 — rapid, where F is ignored: `x10 f100` then goes at
// full speed. Said under such a line; null for any other.
export function feedIgnoredHint(text) {
  const line = String(text || '').trim();
  const moves = /(^|[\s\d])[xyzabc]\s*-?[\d.]/i.test(line);
  const feeds = /(^|[\s\d])f\s*[\d.]/i.test(line);
  const motionWord = /(^|[\s\d])g\s*0*[0-3](?!\d)/i.test(line);
  if (line.startsWith('$') || !moves || !feeds || motionWord) return null;
  return 'no G0/G1 in that line: it moves in the last motion mode, G0 (rapid, F ignored) after a reset. For a slow move: G1 ' + line;
}

// Walking the typed lines with up and down: `at` is the position in
// `history` (history.length = the fresh, empty line).
export function historyStep(history, at, key) {
  if (!history.length) return { at, text: null };
  const next = Math.max(0, Math.min(history.length, at + (key === 'ArrowUp' ? -1 : 1)));
  return { at: next, text: history[next] ?? '' };
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

const ICONS = {
  files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
function iconButton(name, label) {
  const b = button('', 'cnc-icon-btn', label);
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg><span>${label}</span>`;
  return b;
}

const TABS = [['control', 'Control'], ['program', 'Program'], ['terminal', 'Terminal']];

export function mountCncControl(target, {
  shell, isLinked = () => true, isBusy = () => false, program = '', saveProgram = () => {}, settings = null, tab = 'control',
  subscribeReports = null,
} = {}) {
  const app = el('div', 'cnc-app');
  app.dataset.tab = tab;
  target.appendChild(app);

  // ── Header: title, state, position, error ──
  const header = el('header', 'cnc-app-head');
  const titleRow = el('div', 'cnc-app-title-row');
  const filesBtn = iconButton('files', 'Files');
  const settingsBtn = iconButton('settings', 'Settings');
  titleRow.append(el('h2', 'cnc-app-title', 'CNC'), el('span', 'cnc-spacer'), filesBtn, settingsBtn);
  header.appendChild(titleRow);
  app.appendChild(header);

  const sections = {};
  const main = el('div', 'cnc-app-main');
  app.appendChild(main);
  for (const [key, label] of TABS) {
    const section = el('section', 'cnc-app-section');
    section.dataset.tab = key;
    section.appendChild(el('h3', 'cnc-app-label', label));
    sections[key] = section;
  }
  const side = el('div', 'cnc-app-side');
  side.append(sections.program, sections.terminal);
  main.append(sections.control, side);

  const tabs = el('nav', 'cnc-app-tabs');
  const tabButtons = {};
  for (const [key, label] of TABS) {
    const b = button(label, 'cnc-app-tab');
    b.addEventListener('click', () => show(key));
    tabButtons[key] = b;
    tabs.appendChild(b);
  }
  app.appendChild(tabs);
  function show(key) {
    app.dataset.tab = key;
    for (const [k, b] of Object.entries(tabButtons)) b.classList.toggle('cnc-active', k === key);
    if (key === 'terminal') termOut.scrollTop = termOut.scrollHeight;
  }

  // ── Terminal ──
  const termOut = el('pre', 'cnc-term-out');
  termOut.setAttribute('aria-live', 'polite');
  const termRow = el('div', 'cnc-term-row');
  const termIn = el('input', 'cnc-input cnc-term-in');
  termIn.type = 'text';
  termIn.placeholder = 'gcode, $$, help · @log';
  termIn.enterKeyHint = 'send';
  termIn.autocapitalize = 'off';
  termIn.autocomplete = 'off';
  termIn.spellcheck = false;
  const termSend = button('Send', 'cnc-btn');
  const termCopy = button('Copy', 'cnc-btn', 'Copy the whole terminal');
  termRow.append(termIn, termSend, termCopy);
  sections.terminal.append(termOut, termRow);

  const termLines = [];
  // Commands and notes carry the time, so a terminal copied into a message
  // says what happened when (replies follow their command).
  const clock = () => new Date().toTimeString().slice(0, 8);
  function termPrint(text, kind = '') {
    const stamped = kind === 'cmd' || kind === 'note' ? `${clock()} ${text}` : text;
    for (const line of String(stamped).split('\n')) {
      const row = el('div', kind ? `cnc-term-${kind}` : '', line);
      termOut.appendChild(row);
      termLines.push(line);
    }
    while (termOut.childElementCount > TERMINAL_LINES) { termOut.firstChild.remove(); termLines.shift(); }
    termOut.scrollTop = termOut.scrollHeight;
  }
  function printReply(line, reply) {
    termPrint(`> ${line.replace(/^cnc /, '')}`, 'cmd');
    for (const text of reply.lines || []) termPrint(text, /^(error|ALARM)/.test(text) ? 'err' : '');
    if (!reply.ok && !(reply.lines || []).some((l) => /^error/.test(l))) termPrint(`error: ${reply.error || 'no answer'}`, 'err');
  }
  const say = (text) => termPrint(`# ${text}`, 'note');
  termPrint("Terminal: gcode and grbl's commands (help, ls, $$, ?); @log, @limit forget for the board.", 'note');

  const typed = [];
  let typedAt = 0;
  async function sendTyped() {
    const text = termIn.value.trim();
    const line = terminalLine(text);
    if (!line) return;
    termIn.value = '';
    if (typed[typed.length - 1] !== text) typed.push(text);
    typedAt = typed.length;
    if (!isLinked()) { termPrint(`> ${text}`, 'cmd'); termPrint('not connected to the board', 'err'); return; }
    const reply = await shell(line, { timeoutMs: 5000 }).catch((err) => ({ ok: false, lines: [], error: err.message }));
    printReply(line, reply);
    if (feedIgnoredHint(text)) say(feedIgnoredHint(text));
  }
  termSend.addEventListener('click', sendTyped);
  termIn.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const step = historyStep(typed, typedAt, event.key);
      if (step.text === null) return;
      typedAt = step.at;
      termIn.value = step.text;
      event.preventDefault();
      requestAnimationFrame(() => termIn.setSelectionRange(termIn.value.length, termIn.value.length));
      return;
    }
    if (event.key === 'Enter') { event.preventDefault(); sendTyped(); }
  });
  termCopy.addEventListener('click', async () => {
    const text = termLines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      termCopy.textContent = 'Copied';
    } catch {
      // A page over plain HTTP (a board's own) has no clipboard API.
      const area = el('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand?.('copy');
      area.remove();
      termCopy.textContent = ok ? 'Copied' : 'Copy failed';
    }
    setTimeout(() => { termCopy.textContent = 'Copy'; }, 1500);
  });

  // ── Program ──
  const toolbar = el('div', 'cnc-toolbar');
  const openBtn = button('Open…', 'cnc-btn', 'Load a gcode file from this device');
  const saveBtn = button('Save…', 'cnc-btn', 'Save the program to a file on this device');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.nc,.gcode,.gc,.g,.ngc,.tap,.txt';
  fileInput.hidden = true;
  const runStatus = el('span', 'cnc-run-status');
  toolbar.append(openBtn, saveBtn, runStatus, fileInput);
  sections.program.appendChild(toolbar);
  const editor = el('textarea', 'cnc-editor');
  editor.spellcheck = false;
  editor.autocapitalize = 'characters';
  editor.autocomplete = 'off';
  editor.placeholder = 'G21 G90\nG0 X0 Y0\nG1 X20 F800\n...';
  editor.value = program || '';
  sections.program.appendChild(editor);
  sections.program.appendChild(el('div', 'cnc-note', 'Run, Hold and Stop are on the pad.'));
  const progress = (text) => { runStatus.textContent = text; };

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
    progress(`${file.name}: ${programLines(editor.value).length} lines`);
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
    editor.readOnly = on;
    tabButtons.program.classList.toggle('cnc-running', on);
    app.classList.toggle('cnc-is-running', on);
  }
  function highlight(index) {
    const lines = editor.value.split('\n');
    let start = 0;
    for (let i = 0; i < index; i++) start += lines[i].length + 1;
    editor.setSelectionRange(start, start + (lines[index] || '').length);
  }
  async function runProgram() {
    const lines = programLines(editor.value);
    if (!lines.length) { say('Nothing to run: the program is empty (Program tab).'); return; }
    const job = { paused: false, stopped: false };
    run = job;
    setRunning(true);
    say(`Running the program: ${lines.length} lines.`);
    let i = 0;
    try {
      while (i < lines.length && !job.stopped) {
        if (job.paused) { await new Promise((r) => setTimeout(r, 150)); continue; }
        const { line, index } = lines[i];
        highlight(index);
        progress(`line ${i + 1}/${lines.length}`);
        const reply = await shell(`cnc ${line}`, { timeoutMs: 5000 }).catch((err) => ({ ok: false, error: err.message }));
        const outcome = lineOutcome(reply);
        if (outcome === 'retry') { await new Promise((r) => setTimeout(r, 200)); continue; }
        if (outcome === 'error') {
          printReply(`cnc ${line}`, reply);
          say(`Stopped at line ${index + 1}: ${reply.error || 'no answer'}`);
          progress(`stopped at line ${index + 1}`);
          job.stopped = true;
          break;
        }
        i += 1;
      }
      if (i >= lines.length) { say(`Sent all ${lines.length} lines; the machine finishes what it has queued.`); progress('sent'); }
      else if (job.stopped && !/^stopped at/.test(runStatus.textContent)) progress(`stopped after line ${i}`);
    } finally {
      if (run === job) run = null;
      setRunning(false);
    }
  }

  // ── The machine ──
  let axes = ['x', 'y'];  // from the status reports: as many as positions
  const panel = mountCncPanel(sections.control, {
    shell, isLinked, isBusy, subscribeReports, headTarget: header, print: printReply, note: (text) => say(text),
    jogFeed: () => settings?.jogFeed?.() || 1000,
    onRun: (state) => {
      if (state.startsWith('Hold') || run?.paused) {
        if (run) run.paused = false;
        panel.send('cnc start');
        return true;
      }
      if (run) return true;  // already running
      if (state.startsWith('Alarm')) { say('In alarm: Home or Unlock first.'); return true; }
      runProgram();
      return true;
    },
    onHold: () => {
      if (run) run.paused = true;
      return false;  // and grbl's feed hold
    },
    onStop: () => {
      if (run) { run.stopped = true; say('Program stopped.'); }
      return false;  // and the panel stops the machine
    },
    onState: (rep) => { axes = AXES.slice(0, rep.mpos?.length || rep.wpos?.length || axes.length); },
  });

  // ── Sheets: Files and Settings, over the app ──
  function openSheet(title) {
    const sheet = el('div', 'cnc-sheet');
    const head = el('div', 'cnc-sheet-head');
    const back = button('‹ Back', 'cnc-btn cnc-sheet-back');
    head.append(back, el('h3', 'cnc-sheet-title', title));
    const body = el('div', 'cnc-sheet-body');
    sheet.append(head, body);
    app.appendChild(sheet);
    const close = () => sheet.remove();
    back.addEventListener('click', close);
    return { body, close };
  }

  filesBtn.addEventListener('click', () => {
    const { body, close } = openSheet('Files on the machine');
    body.appendChild(el('p', 'cnc-note', `The machine keeps four macros and runs them by itself (a button on the bus sends macro run <n>). One line each, up to ${MACRO_MAX} characters of gcode. Longer programs: Program, Open / Save.`));
    const list = el('div', 'cnc-macros');
    body.appendChild(list);
    const cells = new Map();
    for (const n of MACROS) {
      const row = el('div', 'cnc-macro');
      const name = el('span', 'cnc-macro-name', `M${n}`);
      const preview = el('span', 'cnc-macro-text', '...');
      const loadBtn = button('Edit', 'cnc-btn', `Load M${n} into the program`);
      const writeBtn = button('Save', 'cnc-btn', `Store the program as M${n} on the machine`);
      const runOne = button('Run', 'cnc-btn cnc-primary', `The machine runs M${n} by itself`);
      row.append(name, preview, loadBtn, writeBtn, runOne);
      list.appendChild(row);
      cells.set(n, preview);
      loadBtn.addEventListener('click', async () => {
        const reply = await shell(`cnc macro read ${n}`, {}).catch((err) => ({ ok: false, error: err.message }));
        if (!reply.ok) { printReply(`cnc macro read ${n}`, reply); return; }
        editor.value = macroToProgram((reply.lines || []).join(';'));
        saveProgram(editor.value);
        say(`M${n} loaded into the program.`);
        close();
        show('program');
      });
      writeBtn.addEventListener('click', async () => {
        const text = macroText(editor.value);
        if (text === null) { say(`Too long for a macro: ${MACRO_MAX} characters at most once comments are dropped.`); return; }
        const reply = await shell(`cnc macro write ${n} ${text}`, {}).catch((err) => ({ ok: false, error: err.message }));
        printReply(`cnc macro write ${n} …`, reply);
        refresh();
      });
      runOne.addEventListener('click', async () => {
        const reply = await shell(`cnc macro run ${n}`, {}).catch((err) => ({ ok: false, error: err.message }));
        printReply(`cnc macro run ${n}`, reply);
      });
    }
    async function refresh() {
      if (!isLinked() || isBusy()) return;
      const reply = await shell('cnc macro', { quiet: true }).catch(() => null);
      if (!reply?.ok) return;
      for (const text of reply.lines || []) {
        const m = text.match(/^(\d)\s?(.*)$/);
        const cell = m && cells.get(Number(m[1]));
        if (cell) {
          cell.textContent = m[2].trim() || '(empty)';
          cell.title = m[2].trim();
        }
      }
    }
    refresh();
  });

  settingsBtn.addEventListener('click', async () => {
    const { body, close } = openSheet('Settings');
    if (!settings) { body.appendChild(el('p', 'cnc-note', 'No settings for this machine here.')); return; }
    const form = el('form', 'cnc-settings');
    body.appendChild(form);
    const status = el('p', 'cnc-note', 'Reading the machine…');
    body.appendChild(status);
    let values;
    try {
      values = await settings.read(axes);
    } catch (err) {
      status.textContent = `Could not read the settings: ${err.message}`;
      return;
    }
    status.textContent = '';
    const field = (label, input, hint) => {
      const row = el('label', 'cnc-field');
      row.append(el('span', 'cnc-field-label', label), input);
      if (hint) row.appendChild(el('span', 'cnc-field-hint', hint));
      form.appendChild(row);
      return input;
    };
    const number = (value, min, max) => {
      const input = el('input', 'cnc-input');
      Object.assign(input, { type: 'number', inputMode: 'numeric', min, max, step: 'any', value: value ?? '' });
      return input;
    };
    form.appendChild(el('h4', 'cnc-settings-group', 'Jog'));
    const jogIn = field('Jog speed', number(values.jogFeed, 1, 20000), 'mm/min while a jog button is held');
    form.appendChild(el('h4', 'cnc-settings-group', 'Motors'));
    const idleIn = el('select', 'cnc-select');
    idleIn.append(
      Object.assign(document.createElement('option'), { value: 'on', textContent: 'stay powered (hold position)' }),
      Object.assign(document.createElement('option'), { value: 'off', textContent: 'power off 250 ms after a move' }),
    );
    idleIn.value = values.idlePowered === false ? 'off' : 'on';
    field('When idle', idleIn, 'needs the driver’s enable input wired to the board (stepper/disable/pin)');
    form.appendChild(el('h4', 'cnc-settings-group', 'Homing'));
    const seekIn = field('Homing speed', number(values.seek, 1, 20000), 'mm/min toward the switch');
    const feedIn = field('Touch-off speed', number(values.feed, 1, 20000), 'mm/min for the slow second touch that sets zero');
    const pulloffIn = field('Pull-off', number(values.pulloff, 0.1, 50), 'mm back off the switch; raise it with a faster homing speed');
    const dirIns = {};
    for (const axis of axes) {
      const select = el('select', 'cnc-select');
      select.append(
        Object.assign(document.createElement('option'), { value: 'min', textContent: 'toward min (−)' }),
        Object.assign(document.createElement('option'), { value: 'max', textContent: 'toward max (+)' }),
      );
      select.value = values.homeToMin[axis] ? 'min' : 'max';
      dirIns[axis] = field(`${axis.toUpperCase()} homes`, select);
    }
    const actions = el('div', 'cnc-settings-actions');
    const saveSettings = button('Save', 'cnc-btn cnc-primary');
    saveSettings.type = 'submit';
    actions.append(saveSettings);
    form.appendChild(actions);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const next = {
        jogFeed: Number(jogIn.value),
        seek: Number(seekIn.value),
        feed: Number(feedIn.value),
        pulloff: Number(pulloffIn.value),
        idlePowered: idleIn.value === 'on',
        homeToMin: Object.fromEntries(axes.map((a) => [a, dirIns[a].value === 'min'])),
      };
      if (!(next.jogFeed > 0 && next.seek > 0 && next.feed > 0 && next.pulloff > 0)) { status.textContent = 'Speeds and the pull-off must be above 0.'; return; }
      saveSettings.disabled = true;
      status.textContent = 'Saving to the machine…';
      try {
        await settings.save(next, axes);
        panel.refreshFeeds();
        say(`Settings saved: jog ${next.jogFeed}, homing ${next.seek} / ${next.feed} mm/min, pull-off ${next.pulloff} mm, ${axes.map((a) => `${a.toUpperCase()} ${next.homeToMin[a] ? 'min' : 'max'}`).join(', ')}.`);
        close();
      } catch (err) {
        status.textContent = `Not saved: ${err.message}`;
        saveSettings.disabled = false;
      }
    });
  });

  show(tab);
  return () => {
    if (run) run.stopped = true;
    clearTimeout(saveTimer);
    saveProgram(editor.value);
    panel();
  };
}
