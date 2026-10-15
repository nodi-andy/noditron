// The machine panel: what the CNC module's own web page used to be (grbl's
// WebUI, which the old CNC firmware served and its dialog showed in an
// iframe), drawn by noditron itself and driven through the board's shell —
// so it works over whatever link the board has: USB, WiFi, or a CAN hop
// through another board. Nothing page-sized crosses the link, only lines.
//
// The noditron firmware has grbl inside (conucon's esp32_logic, built with
// LOGIC_WITH_CNC) and reaches it as `cnc <line>`: `cnc ?` is grbl's status
// report, and the CNC's own shell words go the same way — `home`, `unlock`,
// `stop` (cancels a jog, holds a running program), `start` (resumes it),
// `reset`, `zero`, and the pulsed jog `x jog start plus|minus [feed]` /
// `x jog continue` / `x jog stop`. A jog pulse has to come every 200 ms or
// the CNC stops the axis by itself (JOG_PULSE_MS in grbl's Module.cpp), so
// a dropped link, a closed tab or a lost pointer can never leave an axis
// running. Anything else typed in the line goes to grbl as gcode.
//
//   mountCncPanel(target, { shell, isLinked, isBusy, hideWhenAbsent })
//
// `shell(line, opts)` is the board's (serialConsole.shell bound to it),
// resolving to { ok, lines, error }. `isLinked()` says whether the board
// has a link at all; `isBusy()` is true while a firmware install holds it.
// With `hideWhenAbsent` the target stays hidden until the board answers
// `cnc ?` with a status report (a board without grbl never shows it).
// Returns a stop function; the panel also stops itself once `target`
// leaves the document.

const POLL_MS = 500;
const PULSE_MS = 100;
const AXES = ['X', 'Y', 'Z', 'A', 'B', 'C'];
const FEEDS = [['', 'default feed'], ['100', '100 mm/min'], ['500', '500 mm/min'], ['1000', '1000 mm/min'], ['3000', '3000 mm/min']];
const STEPS = [['hold', 'hold to jog'], ['0.1', 'step 0.1 mm'], ['1', 'step 1 mm'], ['10', 'step 10 mm']];

// grbl's status report: <State|MPos:x,y|FS:f,s|WCO:x,y|...>. WCO only
// comes every so often, so the caller keeps the last one.
export function parseStatusReport(line) {
  const m = String(line || '').trim().match(/^<([^|>]+)((?:\|[^>]*)?)>$/);
  if (!m) return null;
  const out = { state: m[1], fields: {} };
  for (const part of m[2].split('|').filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    out.fields[part.slice(0, i)] = part.slice(i + 1);
  }
  const nums = (text) => (text === undefined ? null : text.split(',').map(Number));
  out.mpos = nums(out.fields.MPos);
  out.wpos = nums(out.fields.WPos);
  out.wco = nums(out.fields.WCO);
  out.feed = out.fields.FS ? Number(out.fields.FS.split(',')[0]) : out.fields.F ? Number(out.fields.F) : null;
  out.pins = out.fields.Pn || '';
  return out;
}

// What the board's reply to `cnc ?` says: a report, no grbl at all, or
// an answer that is neither (a link that dropped, a busy board).
export function readStatusReply(reply) {
  const report = (reply?.lines || []).map(parseStatusReport).find(Boolean);
  if (report) return { kind: 'report', report };
  const error = String(reply?.error || '');
  if (/unknown command/i.test(error)) return { kind: 'absent' };
  return { kind: 'silent', error: error || 'no answer' };
}

// The line a jog button sends: the pulsed jog while held, or one grbl jog
// move of `step` mm in step mode.
export function jogLine(axis, dir, { step = 'hold', feed = '' } = {}) {
  const letter = String(axis).toUpperCase();
  if (step === 'hold') return `cnc ${letter.toLowerCase()} jog start ${dir < 0 ? 'minus' : 'plus'}${feed ? ` ${feed}` : ''}`;
  const distance = (dir < 0 ? -1 : 1) * Number(step);
  return `cnc $J=G91 G21 ${letter}${distance} F${feed || 1000}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function select(options, className) {
  const node = el('select', className);
  for (const [value, label] of options) node.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }));
  return node;
}

// The panel's markup is classes (cnc-*, styled in styles.css), so the CNC
// control can lay it out as an app on a phone and as a column beside the
// editor on a desktop. `headTarget`: where the state and position go —
// the control puts them in its sticky header; alone they lead the panel.
export function mountCncPanel(target, { shell, isLinked = () => true, isBusy = () => false, hideWhenAbsent = false, headTarget = null } = {}) {
  if (hideWhenAbsent) target.style.display = 'none';
  const root = el('div', 'cnc-panel');
  target.appendChild(root);

  const head = el('div', 'cnc-head');
  const badge = el('span', 'cnc-state', '...');
  const dro = el('div', 'cnc-dro');
  const feedEl = el('span', 'cnc-feed');
  head.append(badge, dro, feedEl);
  const hintEl = el('div', 'cnc-hint');
  hintEl.hidden = true;
  (headTarget || root).append(head, hintEl);

  const actions = el('div', 'cnc-actions');
  [
    ['Home', 'cnc home', 'Run the homing cycle ($H)', ''],
    ['Unlock', 'cnc unlock', 'Back to Idle: clears an alarm, ends a hold or a jog', ''],
    ['Zero', 'cnc zero', 'Make the current position the work zero (no motion)', ''],
    ['Hold', 'cnc stop', 'Cancel a jog, pause a running program', 'cnc-warn'],
    ['Resume', 'cnc start', 'Resume a paused program', ''],
    ['Reset', 'cnc reset', 'Soft reset (ctrl-x)', 'cnc-danger'],
  ].forEach(([label, line, title, tone]) => {
    const b = el('button', `cnc-btn ${tone}`.trim(), label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', () => send(line));
    actions.appendChild(b);
  });
  root.appendChild(actions);

  const jogHead = el('div', 'cnc-jog-head');
  const stepSel = select(STEPS, 'cnc-select');
  const feedSel = select(FEEDS, 'cnc-select');
  jogHead.append(stepSel, feedSel);
  root.appendChild(jogHead);
  const jogPad = el('div', 'cnc-jog');
  root.appendChild(jogPad);

  const gcodeRow = el('div', 'cnc-mdi');
  const gcodeInput = el('input', 'cnc-input');
  gcodeInput.placeholder = 'gcode, e.g. G0 X10 F1000';
  gcodeInput.enterKeyHint = 'send';
  gcodeInput.autocapitalize = 'characters';
  gcodeInput.autocomplete = 'off';
  gcodeInput.spellcheck = false;
  const gcodeSend = el('button', 'cnc-btn', 'Send');
  gcodeSend.type = 'button';
  gcodeRow.append(gcodeInput, gcodeSend);
  root.appendChild(gcodeRow);
  const replyEl = el('div', 'cnc-reply');
  root.appendChild(replyEl);

  let stopped = false;
  let present = !hideWhenAbsent;
  let wco = null;
  let axisCount = 0;
  let jogging = null; // { axis, button, timer }

  function showReply(line, reply) {
    const body = (reply.lines || []).filter((l) => !parseStatusReport(l)).join('\n');
    replyEl.classList.toggle('cnc-error', !reply.ok);
    replyEl.textContent = '> ' + line.replace(/^cnc /, '') + (body ? '\n' + body : '') + (reply.ok ? '' : '\nerror: ' + (reply.error || 'no answer'));
  }

  async function send(line) {
    if (!isLinked()) return null;
    try {
      const reply = await shell(line, { timeoutMs: 4000 });
      showReply(line, reply);
      poll();
      return reply;
    } catch (err) {
      showReply(line, { ok: false, error: err.message });
      return null;
    }
  }

  function sendGcode() {
    const text = gcodeInput.value.trim();
    if (!text) return;
    send('cnc ' + text);
    gcodeInput.select();
  }
  gcodeSend.addEventListener('click', sendGcode);
  gcodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); sendGcode(); }
  });

  function stopJog() {
    if (!jogging) return;
    const { axis, button } = jogging;
    clearTimeout(jogging.timer);
    button?.classList.remove('cnc-pressed');
    jogging = null;
    if (isLinked()) shell(`cnc ${axis} jog stop`, { quiet: true, timeoutMs: 1500 }).catch(() => {});
  }

  // Held: start, then a `continue` every PULSE_MS for as long as the
  // pointer stays down — each one sent only after the last was answered,
  // so a slow link sends fewer, never a backlog.
  async function startJog(axis, dir, button) {
    stopJog();
    const job = { axis, button, timer: null };
    jogging = job;
    button?.classList.add('cnc-pressed');
    const reply = await shell(jogLine(axis, dir, { feed: feedSel.value }), { quiet: true, timeoutMs: 1500 }).catch((err) => ({ ok: false, error: err.message }));
    if (!reply.ok) {
      showReply(jogLine(axis, dir, { feed: feedSel.value }), reply);
      if (jogging === job) {
        jogging = null;
        button?.classList.remove('cnc-pressed');
      }
      return;
    }
    const pulse = async () => {
      if (jogging !== job) return;
      const at = Date.now();
      await shell(`cnc ${axis} jog continue`, { quiet: true, timeoutMs: 1000 }).catch(() => {});
      if (jogging !== job) return;
      job.timer = setTimeout(pulse, Math.max(0, PULSE_MS - (Date.now() - at)));
    };
    job.timer = setTimeout(pulse, PULSE_MS);
  }

  function jogButton(axis, dir, area) {
    const b = el('button', 'cnc-btn cnc-jog-btn', `${axis.toUpperCase()}${dir < 0 ? '−' : '+'}`);
    b.type = 'button';
    b.title = `${axis.toUpperCase()}${dir < 0 ? '-' : '+'}`;
    if (area) b.style.gridArea = area;
    // A long press on a phone would otherwise open the context menu.
    b.addEventListener('contextmenu', (event) => event.preventDefault());
    b.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !isLinked()) return;
      event.preventDefault();
      if (stepSel.value === 'hold') {
        b.setPointerCapture?.(event.pointerId);
        startJog(axis, dir, b);
      } else {
        send(jogLine(axis, dir, { step: stepSel.value, feed: feedSel.value }));
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, stopJog);
    return b;
  }

  // X and Y as a cross (Y+ away from you), Stop in its middle; Z and any
  // further axis as an up/down pair beside it.
  function buildJog(count) {
    if (count === axisCount) return;
    axisCount = count;
    jogPad.replaceChildren();
    const cross = el('div', 'cnc-jog-cross');
    if (count >= 1) cross.append(jogButton('x', -1, 'xm'), jogButton('x', 1, 'xp'));
    if (count >= 2) cross.append(jogButton('y', 1, 'yp'), jogButton('y', -1, 'ym'));
    const halt = el('button', 'cnc-btn cnc-jog-stop cnc-warn', 'Stop');
    halt.type = 'button';
    halt.title = 'Cancel the jog (and hold a running program)';
    halt.addEventListener('click', () => { stopJog(); send('cnc stop'); });
    cross.appendChild(halt);
    jogPad.appendChild(cross);
    for (const name of AXES.slice(2, count)) {
      const axis = name.toLowerCase();
      const column = el('div', 'cnc-jog-column');
      column.append(jogButton(axis, 1, null), jogButton(axis, -1, null));
      jogPad.appendChild(column);
    }
  }

  function render(report) {
    badge.textContent = report.state;
    badge.dataset.state = report.state.split(':')[0];
    if (report.wco) wco = report.wco;
    const mpos = report.mpos || (report.wpos && wco ? report.wpos.map((v, i) => v + (wco[i] || 0)) : null);
    const wpos = report.wpos || (mpos && wco ? mpos.map((v, i) => v - (wco[i] || 0)) : null);
    const pos = wpos || mpos;
    if (pos) {
      buildJog(Math.min(pos.length, AXES.length));
      if (dro.childElementCount !== pos.length) {
        dro.replaceChildren(...pos.map((_, i) => {
          const cell = el('span', 'cnc-dro-axis');
          cell.append(el('b', '', AXES[i]), el('span', 'cnc-dro-value'));
          return cell;
        }));
      }
      pos.forEach((v, i) => { dro.children[i].lastChild.textContent = v.toFixed(3); });
      dro.title = wpos && mpos ? 'work position' : 'machine position';
    }
    feedEl.textContent = report.feed ? `F${report.feed}` : '';
    const alarm = report.state.startsWith('Alarm');
    hintEl.hidden = !(alarm || report.pins);
    hintEl.textContent = [alarm ? 'Alarm: Home, or Unlock to move without homing.' : '', report.pins ? `Inputs on: ${report.pins}` : ''].filter(Boolean).join('  ');
  }

  function showOffline(text) {
    badge.textContent = text;
    badge.dataset.state = '';
  }

  let polling = false;
  let pollTimer = null;
  async function poll() {
    if (stopped || polling) return;
    if (!target.isConnected) { stop(); return; }
    if (!isLinked()) {
      showOffline('not connected');
      if (hideWhenAbsent) target.style.display = 'none';
      return;
    }
    if (isBusy()) return;
    polling = true;
    try {
      const reply = await shell('cnc ?', { quiet: true, timeoutMs: 1500 });
      const read = readStatusReply(reply);
      if (read.kind === 'report') {
        if (!present) { present = true; target.style.display = ''; }
        render(read.report);
      } else if (read.kind === 'absent') {
        present = false;
        if (hideWhenAbsent) target.style.display = 'none';
        else showOffline('no CNC in this firmware');
      } else {
        showOffline('no answer');
      }
    } catch {
      showOffline('no answer');
    } finally {
      polling = false;
    }
  }

  function loop() {
    if (stopped) return;
    poll().finally(() => {
      if (!stopped) pollTimer = setTimeout(loop, POLL_MS);
    });
  }

  const onHide = () => stopJog();
  window.addEventListener('pagehide', onHide);
  window.addEventListener('blur', onHide);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(pollTimer);
    stopJog();
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('blur', onHide);
  }

  loop();
  return stop;
}
