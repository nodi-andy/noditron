// The machine panel: what the CNC module's own web page used to be (grbl's
// WebUI, which the old CNC firmware served and its dialog showed in an
// iframe), drawn by noditron itself and driven through the board's shell —
// so it works over whatever link the board has: USB, WiFi, or a CAN hop
// through another board. Nothing page-sized crosses the link, only lines.
//
// The noditron firmware has grbl inside (conucon's esp32_logic, built with
// LOGIC_WITH_CNC) and reaches it as `cnc <line>`: `cnc ?` is grbl's status
// report, and the CNC's own shell words go the same way — `home`, `unlock`,
// `stop` (cancels a jog, holds a running program), `start` (cycle start:
// resumes a held program), `reset`, `zero`, and the pulsed jog `x jog
// start plus|minus [feed]` / `x jog continue` / `x jog stop`. A jog pulse
// has to come every 200 ms or the CNC stops the axis by itself (JOG_PULSE_MS
// in grbl's Module.cpp), so a dropped link, a closed tab or a lost pointer
// can never leave an axis running.
//
//   mountCncPanel(target, { shell, isLinked, isBusy, hideWhenAbsent,
//                           headTarget, print, onRun, onHold, onStop,
//                           onState, jogFeed, subscribeReports })
//
// `shell(line, opts)` is the board's (serialConsole.shell bound to it),
// resolving to { ok, lines, error }. `isLinked()` says whether the board
// has a link at all; `isBusy()` is true while a firmware install holds it.
// With `hideWhenAbsent` the target stays hidden until the board answers
// `cnc ?` with a status report (a board without grbl never shows it).
// `headTarget`: where the state, position and error line go (the CNC
// control's header); alone they lead the panel. `print(line, reply)`: a
// terminal that shows every command and its answer; without one the panel
// shows the last answer under itself. `onRun/onHold/onStop(state)` let the
// control put its program run behind the pad's buttons — returning true
// means handled. `onState(report)` hears every status report. `jogFeed()`
// is the jog speed from the control's settings. `subscribeReports(fn)`
// hears the status reports the CNC pushes on its own (a CNC across the
// bus, firmware 20261018m on): once one came, `cnc ?` is only a heartbeat
// every HEARTBEAT_MS — what keeps this panel a watcher of that CNC, and
// tells a CNC gone quiet — instead of a poll every POLL_MS.
// Returns a stop function; the panel also stops itself once `target`
// leaves the document.

const POLL_MS = 500;
const HEARTBEAT_MS = 5000;
// A moving machine pushes four reports a second: a poll that finds it
// moving with none for this long is a CNC that stopped pushing (an older
// firmware flashed meanwhile), and the panel polls again.
const PUSH_STALE_MS = 2000;
const MOVING_RE = /^(Run|Jog|Home|Hold)/;
const PULSE_MS = 100;
const AXES = ['X', 'Y', 'Z', 'A', 'B', 'C'];
const FEEDS = ['100', '500', '1000', '3000', '6000'];
const STEPS = [['hold', 'Hold to jog'], ['0.1', 'Step 0.1 mm'], ['1', 'Step 1 mm'], ['10', 'Step 10 mm']];

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

// Why the machine is in alarm, from the board's `log` (grbl's recent
// messages, newest last): the last line that says alarm, a limit or a
// stop, without its "[MSG:" wrapping. Null when it says nothing of it.
export function alarmReason(lines) {
  const said = (lines || []).map((l) => String(l).replace(/^\s*[\d.]+s ago\s+/, '').trim());
  for (let i = said.length - 1; i >= 0; i -= 1) {
    if (/alarm|limit|not watched|stopping/i.test(said[i])) return said[i].replace(/^\[MSG:\s*/, '').replace(/\]$/, '');
  }
  return null;
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

// The panel's markup is classes (cnc-*, styled in styles.css), so the CNC
// control can lay it out as an app on a phone and as a column beside the
// editor on a desktop.
export function mountCncPanel(target, {
  shell, isLinked = () => true, isBusy = () => false, hideWhenAbsent = false, headTarget = null,
  print = null, onRun = null, onHold = null, onStop = null, onState = null, jogFeed = () => 1000, note = () => {},
  subscribeReports = null,
} = {}) {
  if (hideWhenAbsent) target.style.display = 'none';
  const root = el('div', 'cnc-panel');
  target.appendChild(root);

  // ── Head: state, position, feed; the error line under them ──
  const head = el('div', 'cnc-head');
  const badge = el('span', 'cnc-state', '...');
  const dro = el('div', 'cnc-dro');
  const feedEl = el('span', 'cnc-feed');
  head.append(badge, dro, feedEl);
  const errorEl = el('div', 'cnc-error-line');
  errorEl.hidden = true;
  (headTarget || root).append(head, errorEl);

  // ── The pad: the jog cross, the machine's actions in its corners ──
  //   Home   Y+    Unlock
  //   X−     Stop  X+
  //   Hold   Y−    Run
  const jogPad = el('div', 'cnc-jog');
  root.appendChild(jogPad);

  const jogRow = el('div', 'cnc-jog-head');
  const stepSel = el('select', 'cnc-select');
  for (const [value, label] of STEPS) stepSel.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }));
  const feedSel = el('select', 'cnc-select');
  stepSel.title = 'Hold the button to jog, or move a fixed step per press';
  feedSel.title = 'Jog speed';
  jogRow.append(stepSel, feedSel);
  root.appendChild(jogRow);
  function fillFeeds() {
    const chosen = feedSel.value;
    feedSel.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: `Jog ${jogFeed()} mm/min` }));
    for (const f of FEEDS) feedSel.appendChild(Object.assign(document.createElement('option'), { value: f, textContent: `${f} mm/min` }));
    feedSel.value = chosen;
  }
  fillFeeds();
  const feedNow = () => feedSel.value || String(jogFeed());

  const more = el('div', 'cnc-more');
  const zeroBtn = button('Set zero', 'cnc-btn', 'Make the current position the work zero (no motion)');
  const resetBtn = button('Reset', 'cnc-btn cnc-danger', 'Soft reset (ctrl-x): stops everything at once, the position may be lost');
  more.append(zeroBtn, resetBtn);
  root.appendChild(more);

  // Without a terminal of the control's, the last answer shows here.
  const replyEl = print ? null : el('div', 'cnc-reply');
  if (replyEl) root.appendChild(replyEl);

  let stopped = false;
  let present = !hideWhenAbsent;
  let wco = null;
  let axisCount = 0;
  let jogging = null; // { axis, button, timer }
  let state = '';
  let where = '';  // the last position, as the terminal says it: "X 12.300 Y 0.000"
  let lastError = '';
  let alarmText = '';
  let alarmAsked = false;

  function showError() {
    const alarm = state.startsWith('Alarm');
    const text = lastError || (alarm ? (alarmText || 'Alarm: Home, or Unlock to move without homing.') : '');
    errorEl.hidden = !text;
    errorEl.textContent = text;
  }

  function report(line, reply) {
    lastError = reply.ok ? '' : `${line.replace(/^cnc /, '')}: ${reply.error || 'no answer'}`;
    showError();
    if (print) { print(line, reply); return; }
    const body = (reply.lines || []).filter((l) => !parseStatusReport(l)).join('\n');
    replyEl.classList.toggle('cnc-error', !reply.ok);
    replyEl.textContent = '> ' + line.replace(/^cnc /, '') + (body ? '\n' + body : '') + (reply.ok ? '' : '\nerror: ' + (reply.error || 'no answer'));
  }

  async function send(line) {
    if (!isLinked()) return null;
    try {
      const reply = await shell(line, { timeoutMs: 4000 });
      report(line, reply);
      poll();
      return reply;
    } catch (err) {
      report(line, { ok: false, error: err.message });
      return null;
    }
  }

  function stopJog() {
    if (!jogging) return;
    const { axis, button: b } = jogging;
    clearTimeout(jogging.timer);
    b?.classList.remove('cnc-pressed');
    jogging = null;
    note(`jog ${axis.toUpperCase()} released at ${where || '?'}`);
    if (isLinked()) shell(`cnc ${axis} jog stop`, { quiet: true, urgent: true, timeoutMs: 1500 }).catch(() => {});
  }

  // Held: start, then a `continue` every PULSE_MS for as long as the
  // pointer stays down — each one sent only after the last was answered,
  // so a slow link sends fewer, never a backlog. All three go ahead of
  // the state poll in the board's queue (`urgent`, see serialConsole).
  async function startJog(axis, dir, b) {
    stopJog();
    const job = { axis, button: b, timer: null };
    jogging = job;
    b?.classList.add('cnc-pressed');
    const line = jogLine(axis, dir, { feed: feedNow() });
    note(`jog ${axis.toUpperCase()}${dir < 0 ? '-' : '+'} at ${feedNow()} mm/min from ${where || '?'}`);
    const reply = await shell(line, { quiet: true, urgent: true, timeoutMs: 1500 }).catch((err) => ({ ok: false, error: err.message }));
    if (!reply.ok) {
      report(line, reply);
      if (jogging === job) {
        jogging = null;
        b?.classList.remove('cnc-pressed');
      }
      return;
    }
    let saidLateAt = 0;
    const pulse = async () => {
      if (jogging !== job) return;
      const at = Date.now();
      const answer = await shell(`cnc ${axis} jog continue`, { quiet: true, urgent: true, timeoutMs: 1000 }).catch((err) => ({ ok: false, error: err.message }));
      const took = Date.now() - at;
      // The CNC stops a jog that hears no pulse for 200 ms (JOG_PULSE_MS):
      // a slow link shows as a jerky jog, said here once a second at most.
      if ((took > 150 || !answer.ok) && Date.now() - saidLateAt > 1000) {
        saidLateAt = Date.now();
        note(`jog pulse ${answer.ok ? `took ${took} ms` : `failed: ${answer.error || 'no answer'}`} (the CNC stops a jog after 200 ms without one)`);
      }
      if (jogging !== job) return;
      job.timer = setTimeout(pulse, Math.max(0, PULSE_MS - (Date.now() - at)));
    };
    job.timer = setTimeout(pulse, PULSE_MS);
  }

  function jogButton(axis, dir, area) {
    const b = button(`${axis.toUpperCase()}${dir < 0 ? '−' : '+'}`, 'cnc-btn cnc-jog-btn', `Jog ${axis.toUpperCase()}${dir < 0 ? '-' : '+'}`);
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
        send(jogLine(axis, dir, { step: stepSel.value, feed: feedNow() }));
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, stopJog);
    return b;
  }

  function actionButton(label, area, tone, title, run) {
    const b = button(label, `cnc-btn cnc-pad-action ${tone}`.trim(), title);
    b.style.gridArea = area;
    b.addEventListener('click', run);
    return b;
  }

  // Stop: the jog and the program end; a moving machine holds, comes to a
  // standstill and is reset to Idle with its position kept (`unlock`). In
  // alarm nothing moves, and Stop must not clear the alarm.
  async function stopAll() {
    stopJog();
    if (onStop?.(state)) return;
    send(state.startsWith('Alarm') ? 'cnc stop' : 'cnc unlock');
  }

  function buildJog(count) {
    if (count === axisCount) return;
    axisCount = count;
    jogPad.replaceChildren();
    const cross = el('div', 'cnc-jog-cross');
    cross.append(
      actionButton('Home', 'home', '', 'Run the homing cycle ($H)', () => send('cnc home')),
      actionButton('Unlock', 'unlock', '', 'Clear an alarm without homing ($X)', () => send('cnc unlock')),
      actionButton('Hold', 'hold', 'cnc-warn', 'Feed hold: pause the program, or cancel a jog', () => { stopJog(); if (!onHold?.(state)) send('cnc stop'); }),
      actionButton('Run', 'run', 'cnc-primary', 'Run the program, or resume after Hold (cycle start)', () => { if (!onRun?.(state)) send('cnc start'); }),
      actionButton('Stop', 'stop', 'cnc-stop', 'Stop everything: end the jog and the program, back to Idle', stopAll),
    );
    if (count >= 1) cross.append(jogButton('x', -1, 'xm'), jogButton('x', 1, 'xp'));
    if (count >= 2) cross.append(jogButton('y', 1, 'yp'), jogButton('y', -1, 'ym'));
    jogPad.appendChild(cross);
    for (const name of AXES.slice(2, count)) {
      const axis = name.toLowerCase();
      const column = el('div', 'cnc-jog-column');
      column.append(jogButton(axis, 1, null), jogButton(axis, -1, null));
      jogPad.appendChild(column);
    }
  }
  buildJog(2);  // the pad is there before the first report; a third axis adds its column

  zeroBtn.addEventListener('click', () => send('cnc zero'));
  resetBtn.addEventListener('click', () => { stopJog(); send('cnc reset'); });

  // Entering alarm: ask the board's log why, once per alarm.
  async function askWhy() {
    alarmAsked = true;
    const reply = await shell('log', { quiet: true, timeoutMs: 3000 }).catch(() => null);
    alarmText = alarmReason(reply?.lines) || '';
    if (alarmText) {
      alarmText = `Alarm: ${alarmText}`;
      note(alarmText);
    }
    showError();
  }

  function render(rep) {
    const was = state;
    state = rep.state;
    badge.textContent = rep.state;
    badge.dataset.state = rep.state.split(':')[0];
    if (rep.wco) wco = rep.wco;
    const mpos = rep.mpos || (rep.wpos && wco ? rep.wpos.map((v, i) => v + (wco[i] || 0)) : null);
    const wpos = rep.wpos || (mpos && wco ? mpos.map((v, i) => v - (wco[i] || 0)) : null);
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
    feedEl.textContent = [rep.feed ? `F${rep.feed}` : '', rep.pins ? `limit ${rep.pins}` : ''].filter(Boolean).join('  ');
    if (pos) where = pos.map((v, i) => `${AXES[i]} ${v.toFixed(3)}`).join(' ');
    const stateWord = (s) => s.split(':')[0];
    if (was && stateWord(was) !== stateWord(state)) note(`${stateWord(was)} → ${stateWord(state)} at ${where}${rep.pins ? `, limit ${rep.pins}` : ''}`);
    const alarm = state.startsWith('Alarm');
    if (alarm && !was.startsWith('Alarm')) { alarmText = ''; alarmAsked = false; }
    if (alarm && !alarmAsked) askWhy();
    if (!alarm) alarmText = '';
    showError();
    onState?.(rep);
  }

  function showOffline(text) {
    badge.textContent = text;
    badge.dataset.state = '';
  }

  // One poll without a report is a reply that came late or got mixed with
  // other traffic: the last state stands. Three in a row is a machine that
  // does not answer.
  const MISSES_SHOWN = 3;
  let misses = 0;
  function missed(text) {
    misses += 1;
    if (misses >= MISSES_SHOWN || !state) showOffline(text);
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
        misses = 0;
        if (!present) { present = true; target.style.display = ''; }
        if (pushing && MOVING_RE.test(read.report.state) && Date.now() - pushedAt > PUSH_STALE_MS) pushing = false;
        render(read.report);
      } else if (read.kind === 'absent') {
        present = false;
        if (hideWhenAbsent) target.style.display = 'none';
        else showOffline('no CNC in this firmware');
      } else {
        missed('no answer');
      }
    } catch {
      missed('no answer');
    } finally {
      polling = false;
    }
  }

  function loop() {
    if (stopped) return;
    poll().finally(() => {
      if (!stopped) pollTimer = setTimeout(loop, pushing ? HEARTBEAT_MS : POLL_MS);
    });
  }

  // What the CNC pushes (see subscribeReports above): drawn as it comes.
  let pushing = false;
  let pushedAt = 0;
  const stopReports = subscribeReports?.((line) => {
    if (stopped) return;
    const rep = parseStatusReport(line);
    if (!rep) return;
    pushing = true;
    pushedAt = Date.now();
    misses = 0;
    if (!present) { present = true; target.style.display = ''; }
    render(rep);
  });

  const onHide = () => stopJog();
  window.addEventListener('pagehide', onHide);
  window.addEventListener('blur', onHide);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(pollTimer);
    stopReports?.();
    stopJog();
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('blur', onHide);
  }

  loop();
  stop.send = send;
  stop.refreshFeeds = fillFeeds;
  stop.state = () => state;
  return stop;
}
