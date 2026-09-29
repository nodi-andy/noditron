# Handover — noditron × ESP32-S3 (Waveshare 8DI/8DO) × conucon grbl over CAN

Last updated: 2026-09-24.

## Goal

Build a circuit in noditron (running on nodigraph) inside the **esp32-S3** block,
upload it over USB serial to a Waveshare ESP32-S3-POE-ETH-8DI-8DO running
conucon's `esp32_logic` firmware, and drive conucon's **grbl CNC controller**
(`esp32_cnc`) directly over **CAN** — no separate CAN module or bridge in between.

## Repositories (all on `main`, push to `origin` only)

| Repo | Path | Remote to push | Role |
|---|---|---|---|
| noditron | `F:\github\noditron` | `origin` → nodi-andy/noditron | Blocks, runtime, circuit compiler, serial upload, bundled firmware |
| nodigraph | `F:\github\nodigraph` | `origin` → nodi-andy/nodigraph (**never** `nodigraph-old`) | Diagram editor, served read-only by noditron from the sibling checkout |
| conucon | `F:\github\conucon` | `origin` → nodi-andy/conucon | `modules/esp32_logic` (Logic Module firmware), `modules/esp32_cnc` (grbl) |

Run noditron locally: `node server/src/app.js` in `F:\github\noditron` → http://localhost:8090
(also `.claude/launch.json` config `noditron`). Sources are served uncached; a
page reload picks up client edits, nodigraph edits included.

Tests:
- noditron: `node --test tools/*.test.mjs` (27 pass)
- nodigraph: `node --test client/tests/*.test.mjs` (70 pass)

## Hardware facts (verified on the board)

- Board on **COM5**, native USB (303a:1001). The browser holds COM5 while the
  device dialog is connected — close it before using PlatformIO/pyserial.
- DI1–DI8 = GPIO4–11, `INPUT_PULLUP`, a pressed/energised input reads as `1`.
- DO1–DO8 = TCA9554 EXIO1–8 (I2C SDA42/SCL41, 0x20). Active-low on this PCB:
  log `EXIO02 pin -> LOW` means DO2 **on**.
- CAN = TWAI TX GPIO2 / RX GPIO3, 250 kbit/s default.
- Firmware on the board: `LogicMod v1.2 build 20260924f`
  (`pio run -d modules/esp32_logic -e logic-s3-waveshare -t upload --upload-port COM5`
  from conucon). Same binary is bundled at
  `noditron/firmware-assets/logic/esp32-s3-waveshare.bin`.

## Serial console commands (esp32_logic)

`?` / `ping` → `[INFO] LogicMod … circuit=… nCB=…`; `design` → `[DESIGN] BEGIN n … END`;
`save-design <n>` → `[DESIGN] READY n`, then n raw bytes → `[DESIGN] Saved n bytes OK`
(reloads the circuit 500 ms later); `pins`; `io <gpio> <0|1>`; `reboot`.

Quick check without the browser (COM5 must be free):
```python
import serial, time
s = serial.Serial('COM5', 115200, timeout=0.2); s.write(b'\ndesign\n'); time.sleep(2); print(s.read(8192).decode()); s.close()
```

## What was fixed this session

1. **Upload “crashed” the S3** — it was stuck, not crashed. The S3's USB console
   (Arduino HWCDC) queues only 256 received bytes and drops the rest; a 928-byte
   design lost bytes, so `save-design` waited forever and swallowed every later
   command as payload.
   - noditron `serialConsole.js`: design sent in 64-byte chunks, 25 ms apart;
     waits for the real `[DESIGN] Saved … OK` (old regex `^Saved` never matched,
     and a timeout used to be reported as success). Unconfirmed save → error.
   - conucon `esp32_logic/src/main.cpp`: `Serial.setRxBufferSize(4096)` before
     `Serial.begin`; build ID `20260924f`.
2. **esp32-S3 pin slots reset on every reload** — `migrateWaveshareBoard`
   (`devkitCircuit.js`) re-applied template positions each load. Now only on
   first conversion to the Waveshare board or when a pin is renamed.
3. **nodigraph: no way to add a second wire to a wired port** — the existing
   wire's head covered the port and grabbing the port moved it.
   **Ctrl + mouse-down** on a port, its connector head or a wire's stub now
   starts a new wire from that port (`DragStateMachine.startNewWireFrom`);
   Ctrl also skips selected-wire grips. Test: `client/tests/ctrl-new-wire.test.mjs`.
4. **DI1 → Data.write → DO2 did nothing** — compiled as “send 0 once at boot”.
   Verified on hardware after the fix: DI1 press/release toggles DO2.
5. **Match blocks were silently dropped** — now compiled (see below).
6. Latent crash: `propOf` was undefined inside `buildMinimalDesign`; now module-level.

## Circuit compiler rules (noditron → conucon belts)

Entry: `devkitCircuit.buildDevkitDesign` → `buildPinMappedDesign` (board pins
become synthetic Digital I/O blocks; CAN Out/In = gpio 2000/2001, rewritten to
`can` blocks) → `serialConsole.buildMinimalDesign`.

- **Pass-throughs** (`collapsePassThroughs`): a pin-less Bool (via `in`) and any
  **Data with `write` wired** (via `write`, matching `DATA_FN`: `out` carries what
  was written). Several `write` wires = a merge; every source feeds what `out` drives.
- **Data with only `in` wired** = trigger: firmware `data` emits its stored text.
- **Match (`croute`) chains**, conucon GUI layout (`esp32_logic/data/design.json`):
  ```
  source @(0,r) → belt(2,r) → croute @(3,r) h=routes
  route row i → belt(5,r+i) → data @(6,r+i) 2×1 → belt(8,r+i)   (or belts 5..8 if no Data)
  → one sink @(9,top), 2 wide, tall enough for every row (CAN Out or a DO)
  ```
  Groups mixing Data rows and straight rows keep only the Data rows (a data
  block fires every outward belt on its edges, so neighbouring straight belts
  would leak its value). One Data per route row.
- Other patterns: Timer/DI → DO, AND, Data(no input) → pin via boot, USB serial.
- Anything else is still dropped without a warning — a “blocks not compiled”
  warning in the device dialog is a good next step.

## grbl over CAN (conucon `esp32_cnc`, `Machines/waveshare_s3.h`, `Serial.cpp`)

- ID `0x7F0`, 250 kbit/s — both equal the esp32-S3 CAN block defaults.
- Text fragmented: byte0 = bit7 last fragment, bits0–6 sequence; bytes1–7 text.
  `X100` → one frame `7F0#80 58 31 30 30`.
- Each complete message = one grbl line (grbl appends `\n`), queued and released
  one at a time on `ok`/`error:`. Realtime bytes (`!`, `~`, `?`, 0x85…) act at
  once; `ABORT` = reset.
- Replies `ok`, `error:…`, `ALARM:…`, `<Idle|…>` come back on the same ID → the
  S3's **CAN In**.
- A CAN node must ACK frames; without the grbl board (or an adapter in normal
  mode) and 120 Ω termination, TX fails (`[CAN] TX failed … BUS_OFF`).

## Open items / next steps

- **User circuit needs rewiring before upload** (current wiring would send `1`/`0`):
  remove Match → small Data `write` wires (keep `in`), remove `X100.out → big
  Data.in`. Then it compiles to 5 DI → croute → 10 data → one CAN block (~3.3 KB).
- Replace `true`/`false` Data values with real grbl lines (`$X`, `$J=G91 X10 F500`, `!`, `~`).
- **CAN In → Match loops**: grbl's `ok`/`<Idle|MPos:0.000…>` contain `0`/`1`;
  match on something specific (e.g. `ALARM`) or disconnect it.
- Not yet verified end-to-end with the grbl controller on the bus.
- The browser tab's project does not reach the local server's `/api/project`
  (server copy stayed stale all session). nodigraph skips the server save for
  `#d=` share links and `?github=` views — check the tab URL. Board saves are
  unaffected.
- Consider a compiler warning listing blocks it could not place.

## Board firmware 20260924g (flashed 2026-09-24 over COM5)

- `env:logic-s3` now uses `partitions_16mb.csv` (app0/app1 3 MB each, ~10 MB
  LittleFS at 0x610000) and **LittleFS instead of SPIFFS** on every env. A
  board on the old layout needs one full `upload` + `uploadfs` over USB; the
  board's `design.json`/`hwconfig.json` were read off first and put back.
  `uploadfs` was run with `PLATFORMIO_DATA_DIR` pointing at a scratch copy so
  the repo's sample `data/` stayed untouched (the board runs the TCA9554
  active-low; the repo's `data/hwconfig.json` says `none`).
- WiFi station: the board joins a saved network alongside its AP
  (`WIFI_AP_STA`), auto-reconnects, and answers mDNS at
  `logicmod-48c4.local`. Settings sheet → Network → "Join a WiFi network"
  (scan / password / Connect / Forget). Serial: `wifi`, `wifi scan` (ask
  twice), `wifi connect <ssid> <password>`, `wifi forget`. HTTP:
  `/api/wifi/{status,scan,connect,forget}`. Password never served back.
- Node discovery: heartbeat on CAN id `0x7EE` once a second (every 5 s while
  alone), node id = MAC bytes 2-5 → this board is **`a1d148c4`**. `nodes` /
  `GET /api/nodes` list this board and every neighbour heard. CAN is started
  at boot on the Waveshare build even without a CAN block. `esp32_cnc`'s
  `Serial.cpp` sends the same frame (`can_send_hello`, type 2) — flash the CNC
  module with it and it appears in `nodes` within a second of the bus being up.
- `?`/`ping` prints a second line `[INFO] node=… type=logic sta=… ip=… mdns=…
  nodes=N`; the first line is unchanged, so noditron's `identify()` still
  parses it.
- noditron's bundled preset (`firmware-assets/logic/esp32-s3-waveshare.bin` +
  `esp32-s3-partitions.bin`) is this build; `FIRMWARE_PRESETS` build id is
  `20260924g`.
- Next step for "noditron served by the board": the client is ~1.3 MB of ES
  modules (~360 KB gzipped) and now fits the filesystem; still missing are a
  static-file handler with MIME types on the firmware, `/api/project`,
  `/api/modules`, `/api/version` on the board, and a WebSocket/HTTP transport
  in noditron's `serialConsole.js` for the board it is served from (Web
  Serial is not available to a page served over WiFi from the board itself).
- Build 20260925a: the console is a shell (see esp32_logic README "Shell"):
  every reply ends with `ok`/`error:`; `?` answers the node name; `nodes`,
  `wifi status|list|select|pw|on|off`, `ap on|off|name`, `can <text>`.
  noditron: `serialConsole.shell(blockId, line)` collects a reply; the S3
  dialog has CONNECTIVITY (nodes, AP and WiFi toggles, scan/select/password)
  and a SHELL box driven by it.
- 2026-09-25, board off USB, driven over WiFi only: it is at 192.168.1.174 on
  DHLAN (DHCP; the router may hand out another address later). mDNS works —
  `logicmod-48c4.local` answers a unicast mDNS query — but **this Windows PC's
  resolver does not resolve .local**, so use the IP or fix the PC (Bonjour /
  mDNS service), not the board. OTA over the LAN works with no cable:
  `python ~/.platformio/packages/framework-arduinoespressif32/tools/espota.py
  -i 192.168.1.174 -p 3232 -f .pio/build/logic-s3-waveshare/firmware.bin`
  (builds 20260925b..e went on this way). `GET /api/version` reports the
  build.
- The shell now runs over every transport: `POST /api/shell` with a
  `text/plain` body holding the line (reply = exactly the console text, `ok`
  included), `GET /api/shell?line=...`, and WebSocket `{"type":"shell",
  "line":...}` → `{"type":"shell","line","output"}`. `save-design` stays
  serial-only. This is the transport noditron's WiFi mode will use.
- The "AP address changed to 192.168.4.1" scare was not an address reset: the
  AP had been switched **off** (`ap off`, persisted — probably the dialog's
  Access-point checkbox), and the status JSON printed a switched-off
  interface's stock address. `/api/wifi/status` now carries `enabled` per
  radio and no address for an off AP. `ap on` was sent to restore it.
- Build 20260925g (USB-flashed 2026-09-25 after a recovery): `ap on|off` and
  `wifi on|off` had a wrong-index bug (both always switched OFF) — that is
  what turned the AP off from the dialog checkbox; fixed. Shell radio
  changes are applied ~400 ms after the reply so a command sent over WiFi
  gets its `ok`. A board saved with both radios off used to assert in lwIP
  at boot (DNS server before any netif) in an unrecoverable reboot loop —
  the stack is now started before the mode is applied and the captive DNS
  runs only with the AP. `/api/wifi/status` carries `enabled` per radio.
- **OTA slots:** every OTA flips the active slot (app0 ↔ app1). A later USB
  `write_flash 0x10000` lands in app0 and is NOT booted if otadata points at
  app1 — write `firmware-assets/boot_app0.bin` to 0xe000 as well (what the
  noditron flasher and `pio -t upload` do). A boot-looping S3 re-enumerates
  USB so fast that esptool cannot connect: hold BOOT + press RESET, flash
  with `--before no_reset --after no_reset`, then press RESET by hand
  (software resets from esptool left it parked in the ROM bootloader).
- CNC module (conucon esp32_cnc, **classic ESP32 on COM8**, default machine
  `3axis_v4.h`, env `release`, build 20260925a): `Grbl_Esp32/src/Module.cpp`
  is the module layer — shell (`g <gcode>`, `$…`, `status/start/stop/reset/
  home/unlock`, `macro …`, `load/files`, `wifi …`, `ap …`, `name`, `nodes`,
  `ping` → `[INFO] CncMod …`), CAN heartbeat + UDP LAN hello (47474). Node id
  **0dd04644**, name NDTCOM (its $Hostname). One radio at a time (grbl).
- noditron: library module **esp32-cnc** (`tools/build-esp32-cnc-module.mjs`,
  Connectivity/Shell sections copied from the S3 manifest at build time),
  kind `cnc-module`, one `gcode` input forwarded as `g <line>` on change
  (main.js `forwardGcodeToCncModules`), `identify()` reports `kind`
  logic|cnc. Logic Module build 20260925i sends/receives the UDP hello;
  `nodes` shows `via wifi` entries with names.
- Open: the CNC's WiFi transport (its WebUI socket is ESP3D's protocol, not
  the shell), and AP+STA at once on the CNC.
- CNC build 20260925d (COM8): radio changes from the shell are applied ~300 ms
  after the reply; `wifi on` refuses without a real saved network (grbl's
  placeholder SSID "NDTCOM" does not count); a board saved in STA mode with
  nothing to join is switched to AP mode once ~15 s after boot (grbl's own
  join attempt runs before the module layer sees the settings). Dialog hint
  "no shell yet" now needs an old-build reply (`error:N` / JSON); a silent
  board reads "No answer right now".
- 2026-09-25 late: CNC build 20260925e. `wifi status` reports the radio's real
  state (fallback AP shown as on) and names a failed join (wrong password? /
  network not found) from the driver's disconnect reason. CNC joined DHLAN at
  192.168.1.171; both boards list each other in `nodes` **via wifi**. The CNC's
  own page is at http://192.168.1.171/ and the cnc dialog shows it in an
  iframe (MACHINE section).
- CNC build 20260925f: the shell also runs over the WebUI websocket (port 81,
  `{"type":"shell","line":…}`; replies come back as grbl's raw text frames,
  which noditron's WiFi link now reads) and over HTTP (`/api/shell`,
  `/api/version`, `/api/nodes`). The CNC's own `/updatefw` HTTP update did
  not take from a script (connection reset, old build kept running) — flash
  it over COM8. noditron closes a previous link before opening another, so
  a COM session is no longer left open under a WiFi connect.
- CNC build 20260925g: a websocket client that vanished without a close frame
  (a browser tab gone) used to stall the whole web server (HTTP dead, serial
  fine) — the bundled arduinoWebSockets has no heartbeat and no pong event,
  so `WebServer.cpp` derives `ModuleWsServer` to set TCP keepalive on each
  accepted socket (idle 5 s / 2 s / 3 probes) and pings every 5 s; verified:
  HTTP stays up through abrupt drops. noditron closes WiFi links on
  `beforeunload`. The CNC's binary websocket frames are grbl's output;
  `wifiTransport.js` decodes them as console bytes.

## Socket port (2026-09-25): a board's shell as a wire

Both board modules carry one logical port named `socket` (esp32-S3 v1.9.0:
left side under CAN In, `out` by default; esp32-cnc v0.2.0: replaces the
`gcode` input, `in` by default — placed CNC blocks get the port renamed in
place by `refreshEsp32DevkitTemplates`, so a wire on it survives). The
direction, editable in the Inspector, decides which way the shell flows:
`out` — every unsolicited line the board prints leaves through the port
(`[USB] x` as `x`, `{"type":"io"}` telemetry dropped) and the latest is the
port's value; `in` — whatever the wire brings is written to the board's
shell, board-to-board as every line in order, a Data value as it changes.
Replies (`ok` / `error:`) stay in the receiving board's shell box. The
browser side lives in `client/src/socketLink.js` (pure, tested by
`tools/socket-link.test.mjs`); `main.js` wires it into the runtime tick in
place of the old gcode forwarding (no `g ` prefix is added any more — send
`g G0 X1` as the text). A childless block's host-set port value now reaches
`getBoundaryOutput` (see `runtime.js` evaluateSubtree's leaf branch).

**Board to board is hardware, registered at save.** A socket wired to
another board's socket (S3 -> CNC) is not relayed by the browser. Instead
the S3's design, compiled when the graph is saved to the device, carries
where its socket leads: `devkitCircuit.socketLinksFor(esp, level)` reads
the exterior wire on each socket pin ('board' or 'host'), and
`mapEndpoint`'s socket branch compiles an inner wire into the socket as a
`can` block (the same gpio-2000 block CAN Out uses, bus 0x7F0 the grbl
board listens on) when the far end is a board, or as the USB `serial`
block (a `[USB] value` line, which socketLink turns into the socket's
value) when the far end is the browser. Inner wires *from* the socket
compile to the CAN-In block when the far end is a board. The exterior
socket wire itself compiles to nothing. The device-dirty check already
covers the exterior wiring (`devkitSnapshot` includes level connections),
so rewiring the socket marks the board "circuit not saved" and the next
Save sends the new route. Tests: `tools/socket-compile.test.mjs`.

## Debugging the socket: every board's shell box is a terminal on its link

`serialConsole.subscribeConsoleLines` now reports both directions:
`{ line, outgoing: true }` for every line this browser writes to a board
(typed in the shell box, or a wire's value into the board's socket) and
`{ line, unsolicited }` for every line the board sends, with `quiet: true`
on the app's own housekeeping (pin polling, identify, design save, and the
dialog's `nodes` / `wifi status` refreshes, which pass `{ quiet: true }`
to `shell()`). The S3 and CNC dialogs' SHELL box prints everything that is
not quiet, `> ` outgoing and `< ` incoming, replies included — and socket
traffic by name: `socket me>cnc: hellooo` for `[CAN] tx hellooo` (or
`[USB] …` when the socket leads to the browser), `socket cnc>me: ok` for
`[CAN] rx ok` / `[UART2] rx …`, `socket Data>me: G0 X1` for a wire's value
the browser wrote in (`shell()`'s `via: 'socket'`). The peer name comes
from `helpers.console.socketPeers()` (dialogSystem.js): the block the
socket's exterior wire reaches, or 'browser'. The Connectivity refresh
(`nodes`, `wifi status`) now polls every 10 s instead of 4 — it is the
"heartbeat" a terminal on the board's own web page shows, since the CNC's
web terminal mirrors its USB shell.

Firmware side (needs a rebuild + flash; no PlatformIO on this machine):
esp32_logic build `20260925j` prints `[CAN] tx <text>` on the console when
the *circuit's* CAN block sends (the shell's `can <text>` already did);
esp32_cnc build `20260925h` prints `[CAN] rx <line>` / `[UART2] rx <line>`
on the USB console for every complete command line the other transports
deliver (console only, never echoed back onto the bus); grbl's reply to
it already reaches the USB console. So, for Data "hellooo" -> S3 socket
-> CNC socket after a Save to device: the S3 box shows `< [CAN] tx hellooo`
(and the S3's socket pin value becomes `hellooo`); the CNC box shows
`< [CAN] rx hellooo` followed by grbl's `< error:…` (it is not gcode) or
`< ok`. `socketLineOf` strips `[CAN] tx ` like `[USB] `.

## OTA (2026-09-25): both boards updated over WiFi, no serial link needed

`node tools/ota-upload.mjs <host> <firmware.bin>` in conucon POSTs an image
to the board's `/updatefw` and reads `/api/version` back. Boards and images:

- Logic Module (Waveshare S3) `a1d148c4`, `logicmod-48c4.local` =
  192.168.1.174 (DHCP): env `logic-s3-waveshare`,
  `modules/esp32_logic/.pio/build/logic-s3-waveshare/firmware.bin`. Now
  build **20260925j**. noditron's bundled preset carries the same image.
- CNC module `0dd04644` "NDTCOM", 192.168.1.171 (DHCP, no mDNS answer):
  a **classic ESP32, 4 MB flash** — env `release` with the default
  `Machines/3axis_v4.h` (CAN on GPIO22/21), NOT `cnc-s3` (that image is for
  an S3 and the board refuses it after a full upload). Now build
  **20260925h**. `/api/shell?line=ping` answers with the build; the WebUI
  websocket on port 81 carries the `[MSG:Update …]` progress lines.

curl fails against the CNC's `/updatefw` (its `Expect: 100-continue` on a
large POST); fetch from node works. The update keeps LittleFS/SPIFFS, so
the S3's design.json and the CNC's settings survive. After an OTA the
board reboots: reconnect the serial console in noditron.

## The socket is a channel of the shell (2026-09-25, later)

Firmware: esp32_logic **20260925k** has a `socket` design block
(`data: { dest, name }`). What the circuit puts in is announced to every
shell client -- USB console and every WebSocket client -- as
`socket out: <text>` (`shellAnnounce`), then delivered to `dest` (a node
id, or its name) as the shell line `socket <text>`: over WiFi to that
node's `/api/shell` when it was heard by UDP hello (the node table now
keeps the `ip` from the hello), else over CAN. `dest` "host" is the
browser, which reads the announcement. The shell command `socket <text>`
(also a `socket ...` text arriving over CAN) announces `socket in: <text>`
and fires every socket block as an input. esp32_cnc **20260925i**:
`socket <text>` announces `socket in:` to all clients and runs the text
in grbl; a `socket ...` line over CAN/UART2 goes to the module shell, not
raw to grbl. Both OTA'd (`node tools/ota-upload.mjs`).

noditron: `devkitCircuit` compiles an inner wire into the socket pin as a
synthetic pin on gpio 2002 (out) / 2003 (in), rewritten to the `socket`
block with `dest` = the far board's `nodeId` prop (recorded by the dialog
from the `nodes` reply's `... self` line) or its name; the exterior wire
compiles to nothing. `socketLink.socketLineOf` takes `socket out:` lines
(and legacy `[USB]`), and a wire's value into a socket `in` is sent as
`socket <text>`. The SHELL box prints `socket in:`/`socket out:` lines
verbatim, everything else `> `/`< `.

**Status at hand-off:** both boards run the socket firmware — the S3
20260925k (OTA), the CNC **20260925i**, flashed over USB on **COM8** with
`pio run -e release -t upload --upload-port COM8` after eight WiFi OTA
attempts dropped on its weak link (an interrupted transfer leaves the
updater "already running" until a restart). Verified on COM8: `ping`
answers `[INFO] CncMod v1.4a build 20260925i …` and `socket serial-probe`
prints `socket in: serial-probe`. The CNC's COM port on this machine is
COM8; the S3 was COM5.

## Socket delivery fixes (2026-09-26)

- The S3's first saved socket design carried `dest: "cnc"` (the diagram's
  block name), which the S3 could not match to the CNC's own name NDTCOM,
  so it fell back to CAN and the text went nowhere. Now `identify()` reads
  the second `[INFO] node=… name=…` line and both dialogs record `nodeId` /
  `nodeName` on the block at connect; the compiler addresses the far board
  by id, else its own name, else the diagram's name; and the S3 firmware
  (20260926a) matches names case-insensitively and, failing that, sends to
  the only node it knows.
- The CNC's HTTP shell hung on any line forwarded to grbl (`g …`, `$…`,
  `socket …`): the web task wrote client_buffer[CLIENT_WEBUI] and the
  request never completed — the S3's WiFi delivery timed out and nothing
  printed. The module shell now queues such lines for clientCheckTask
  (`module_feed_gated_line`, Serial.cpp), the same gated road CAN/UART2
  lines take; grbl's reply lands on the USB console (build 20260926a).
  HTTP delivery on the S3 blocks its loop up to 1 s per send on a bad link.

- **Delivery is a UDP datagram now (S3 20260926b, CNC 20260926b).** The
  CNC's `/api/shell` completes a grbl-bound line only while a WebUI
  websocket client is attached (the dialog's machine iframe is one), so
  HTTP delivery hung the S3 for its timeout whenever nobody had the page
  open. The S3 now sends `{"socket":1,"from":…,"name":…,"text":…}` to the
  node's ip on the hello port 47474 (fire-and-forget, no stall); both
  firmwares take such a datagram in their hello receiver and run
  `socket <text>` — the CNC in clientCheckTask, where forwardToGrbl may
  write grbl's buffer directly. CAN carries `socket <text>` when the node
  was heard on CAN. Open item: the HTTP shell hang itself.
- **Both boards run 20260926b** (S3 by OTA, CNC flashed on COM8 after the
  WiFi OTA dropped again). Verified from the PC: a socket datagram to
  either board's hello port is announced as `socket in: …`; on the CNC it
  is followed by grbl's reply (`error:9` while in Alarm for non-gcode).
  noditron's bundled S3 preset is 20260926b.
- **Announcements were being hidden by the dialog's own polls.** A line the
  board prints on its own that lands while a quiet command (`nodes`,
  `wifi status`, pin polling) is in flight was classed as that command's
  reply and, being quiet, dropped from the box — and from socketLink's
  stream. `serialConsole.dispatchLines` now treats `socket in:`/
  `socket out:`/`[USB]`/`[CAN]`/`[SOCKET]`/`[NODES]`/`[WIFI]`/`[OTA]`
  lines as unsolicited and never quiet (ANNOUNCEMENT_RE).
- S3 build **20260926c**: `[SOCKET] -> NDTCOM 192.168.1.171:47474 udp sent`
  (or why not) on the console after every socket send, `ip` in
  `/api/nodes`, and a `socket-out <text>` shell command that sends through
  the circuit's socket block for testing. Verified end to end from the PC:
  `socket-out trace-test` on the S3's WiFi shell -> `socket in: trace-test`
  and `error:9` on the CNC. noditron's bundled S3 preset is 20260926c.
- **Announcement format is `<id>@socket><text>`** (S3 20260926d, CNC
  20260926c): node `<id>` put `<text>` on its socket — the sender's own id
  on its shell, the same line on the receiver's; `host@socket>` for text
  from the console/browser, `can@`/`uart2@` for those links. A received
  socket text is also **run as a line of the receiving node's shell**
  (`unlock`, `status`, `g G0 X1`, `wifi status`…; `error:` for anything
  the shell does not know), besides feeding the circuit's socket blocks on
  the S3. noditron: `socketLineOf(line, ownId)` takes only the board's own
  id's lines as its socket-out value (`nodeId` prop; any sender if unknown).
- **CNC 20260926d: no access-point fallback.** A station that fails to
  join stays a station and is told to retry every 20 s (`module_poll`);
  `wifi status` says `sta on: could not join …, retrying`. The AP only
  comes up as a setting (`ap on`), or at start when no network is saved.
  New CNC board (ESP32-D0WDQ6, MAC 8c:aa:b5:85:3b:9c) flashed on **COM4**;
  it starts with no settings: set the network from its shell
  (`wifi select DHLAN`, `wifi pw …`, `wifi on`) or the Connectivity section.
- **CNC 20260926e: the GUI page is in the firmware image** (platformio.ini
  `board_build.embed_files` -> `_binary_Grbl_Esp32_data_index_html_gz_start`, served by
  `handle_root`; `/favicon.ico` likewise). No `index.html.gz` upload, no
  "please upload" page; an OTA carries the page. Rebuild the page with
  `tools/build-gui-gz.js` into `Grbl_Esp32/data/index.html.gz` before a
  firmware build. S3 20260926e: the only-node fallback counts nodes heard
  in the last 30 s, so a swapped-out board's stale entry does not block it.
- **CAN is always on, like serial (CNC 20260926f).** No CAN pin on the
  CNC block; the bus is up at boot on both boards (the S3 hears the CNC
  `via can` once wired), and both consoles announce the traffic: `[CAN] tx
  …` for every text a board puts on the bus (the CNC now too, from
  `can_send_text`, so grbl's replies show as they leave) and `[CAN] rx …`
  for what arrives. The module's default name is **CNC** (WifiConfig.h
  hostname/AP/STA defaults; the old board was renamed with `name CNC`).
  `socket` texts ride the bus as `socket <text>` when the far node was
  heard on CAN.
- **One CAN pin on the S3 (module 1.10.0)**, named `CAN`, direction by the
  wire like a GPIO: into it = send on the bus (the `can` block CAN Out
  compiled to), out of it = receive (CAN In). Placed boards: `CAN Out` is
  renamed to `CAN` in place (aliases in `migrateWaveshareBoard`); an unwired
  `CAN In` is dropped, a wired one kept as a legacy pin. The board's render
  no longer letters its pins — nodigraph's port labels were doubling them.
- **`can` alone reports the bus** on both shells (S3 20260926f, CNC
  20260926g): driver state (RUNNING / BUS_OFF / RECOVERING), pins, error
  counters, frames failed/missed. The S3 announces `[CAN] TX failed …` to
  every shell client now, not only USB. Observed before this: the CNC's
  frames reach the S3 (heard `via can`), but the S3's `can status` never
  printed `[CAN] rx` on the CNC's console — check `can` on the S3 for
  tx_failed / BUS_OFF, and the CNC's RX wiring (3axis_v4.h: TX GPIO22, RX
  GPIO23).
- **`jog <axis>p|m [feed]` on the CNC shell (CNC 20260927a, flashed to COM8
  2026-09-27; `ping` confirms the build).** `jog xp` / `jog xm` /
  `jog yp` / `jog ym` (z, a, b, c too) run that axis until `stop`. It is
  one long `$J=` line into grbl's own parser (`Module.cpp` `jog()`), not
  ESP3D: with soft limits on, `$J=G53 G90 G21 X<end> F<feed>` to the
  machine's end of travel (grbl refuses a jog past it); without them
  `$J=G91 G21 X±100000 F<feed>`. Feed defaults to the axis' `$X/MaxRate`;
  `jog xp 300` overrides it (mm/min). The line sent is echoed as `jog: …`,
  then grbl's own ok / error: follows. `stop` (feed hold) ends a jog: grbl
  turns any hold during Jog into a jog cancel, flushes the plan and returns
  to Idle, so no `~` is needed afterwards; `reset` works too. Flash with
  `pio run -d modules/esp32_cnc -e release -t upload --upload-port COM8`
  in conucon (firmware at `.pio/build/release/firmware.bin`).
- **Add Block window replaces the side palette and "Add from library"
  (noditron, 2026-09-27).** nodigraph's + button now opens
  `client/src/addBlockDialog.js` (capture-phase listener on `#fab-add-block`,
  `stopImmediatePropagation`, so nodigraph's Toolbar.js is untouched): a
  grouped grid — Modules first (Connect USB, Connect IP, then every bundled
  or installed module as a plain tile), then Logic / Data / Time & output /
  Board I/O from `palette.js`'s new `paletteGroups()`. The `#noditron-palette`
  div, its CSS, `mountPalette`, `mountLibrary` and the whole library browse /
  import / export UI are gone; `library.js` keeps the fetch/install API and
  gained `resolveModuleByName` (installed → bundled `/api/modules/<name>` →
  GitHub `noditron-module` repos) and `listBundledModules`.
  Connect: a temp session (`add:<ts>`) is opened (`serialFlash.connect` with
  the chosen port / `connectWifi`), `identify` runs, `moduleDiscovery.js`'s
  `moduleNameFor` maps kind → module (cnc → esp32-cnc; logic → esp32-s3-devkit,
  or esp32-devkit when the port is a bridge chip, i.e. not Espressif's native
  USB vid — `serialFlash.usesNativeUsb` is exported now), the module is placed
  (or the block already carrying that `nodeId` is reused) and the session is
  handed over with `serialFlash.adoptSession(tempId, block.id)`;
  `nodeId`/`nodeName`/`connectionState=connected:running` are set. Then
  `nodes` is run and every `via can` neighbour (`parseNodesOutput` /
  `canNeighbours`) is placed to the right and wired **CAN ↔ CAN**
  (`wireCan`, `project.addConnection`). The CNC module therefore gained a
  `CAN` logical port (right side) plus declared `nodeId`/`nodeName` props
  (`tools/build-esp32-cnc-module.mjs`, module v0.4.0; already-placed CNC
  blocks pick the port up through `refreshEsp32DevkitTemplates`). A board
  that answers nothing keeps the link open and the window offers to place
  esp32-s3-devkit / esp32-devkit / esp32-cnc anyway (`connected:unknown`).
  Tests: `tools/add-block.test.mjs` (69 pass in all). Not done: the CAN wire
  is an ordinary wire the user can delete; making it fixed is future work.
  The window's browser behaviour was not exercised in a headless browser
  (a board was connected in the live session) — first thing to try by hand.
- **Network scanner for Connect IP (2026-09-27).** `server/src/lanDiscovery.js`:
  a UDP listener on 47474 keeps every board hello heard (30 s TTL; both
  firmwares broadcast one every 2 s, source address wins over the `ip`
  field, which is the AP address on a board in AP mode), and `sweepSubnets`
  probes `1..254` of the /24 around each private IPv4 address of this
  machine with `GET /api/version` (700 ms timeout, 64 at a time, ~3 s for
  a /24; both firmwares answer `{node,type,name,version,build}`).
  `GET /api/discover` returns the heard list at once, `?scan=1` adds the
  sweep; results merged by node id (`mergeBoards`, scan wins). The Add
  Block window's Connect IP form loads the heard list when it opens and
  has a "Scan network" button; each board is a tile that connects to its
  address. Tests in `tools/lan-discovery.test.mjs` (73 pass in all).
  Verified live: the S3 at .174 is heard by hello; the sweep finds it and
  the CNC at .171. On Windows the first UDP bind may raise a firewall
  prompt for node.exe; if broadcasts are blocked the sweep still works.
- **Nodes talking to nodes: `node <name|id|*> <line>` on both shells (S3
  build 20260927a, CNC build 20260927b; 2026-09-27).** Runs <line> on the
  named node and prints its answer, ending with that node's ok / error:,
  as if typed there. On the bus (text id 0x7F0, same fragmented text as
  before): request `node <to> <asker-id> <line>`, every reply line
  `reply <asker-id> <its-id> <text>`; the far node runs the line with its
  output captured (S3: `runShellLine`; CNC: `CLIENT_NODE`, a client whose
  client_write goes to the asker — a gcode line goes through the gated
  queue with the asker's id riding along, so grbl's later ok/error is sent
  back too) and prints nothing on its own console. The asker waits up to
  3 s; the S3 pumps `canDrain()` (the loop's CAN drain, now a function)
  while waiting, the CNC pumps `can_poll()` only when the asking line came
  from clientCheckTask itself (USB console), else the task drains as usual.
  `node * <line>` runs everywhere, no answer. A shell connection is just
  another node: the answer goes to whoever asked.
  noditron: `client/src/canBridge.js` + `canBridgeRegistry.js` — every
  board with a link of its own is asked `nodes` every 10 s; a placed block
  whose `nodeId` a running board hears `via can` gets
  `connectionState=connected:running` and `serialConsole.bridgeFor(id)` =
  `{ bridgeId, target }`; `serialConsole.shell/identify` for such a block
  go through the bridge as `node <target> <line>` (quiet on the bridge,
  the reply lines notified to the far block's own listeners, so its dialog's
  shell box shows them). dialogSystem's `helpers.serial.getSession()` returns
  `{ kind: 'can', bridgeId, target }` for it, so the CNC dialog opens on the
  connected path. The S3 was flashed OTA (192.168.1.174) with the new build;
  **the CNC build is NOT flashed** — it was off USB (no COM port) and off
  WiFi at the time; until it is, `node cnc …` answers `error: no reply from
  cnc` after 3 s. `pio run -d modules/esp32_cnc -e release -t upload
  --upload-port COM8`. Tests: `tools/can-bridge.test.mjs`.
- **CNC flashed with 20260927b over COM8 (2026-09-27), but `node cnc …` from
  the S3 still answers "no reply".** Evidence: CNC `nodes` lists only itself
  (nodes=0 — it never hears the S3's hellos either), CNC `can` is clean
  (tec=0 rec=0 bus_errors=0), S3 `can` shows rec=130 (error-passive),
  bus_errors=178008 and queued_tx=6 (frames never leave). Bitrate 250000
  and pins tx 2 / rx 3 match on both sides (S3 design.json can block =
  module canPins). So the S3 → CNC direction of the bus is dead at the
  transceiver/wiring level while CNC → S3 works — the same open issue
  noted above. Not a protocol bug: `node * ping` and the S3's shell path
  work, the CNC runs the node code. Check the S3's CAN transceiver TX
  wiring / termination; to test the protocol meanwhile, `node esp32-s3 …`
  from the CNC's USB console (its request does reach the S3; the reply
  cannot come back). The CNC is also in AP mode now (AP=CNC, 192.168.0.1)
  with DHLAN saved: `wifi on` on its shell rejoins the LAN.
- **`?` is grbl's status report again; `help` is compact (CNC 20260927c,
  S3 20260927b, built 2026-09-27).** The module shells no longer answer
  `?` with the node name (the CNC's `module_shell_feed` passed every other
  realtime byte to grbl but kept `?` for itself; the S3 had the same
  line-start shortcut) — `name` is the node name, `status`/`?` the machine
  state. `help` lists the main commands one line each (a `HelpEntry`
  table in each firmware); `<command> help` prints that command's forms
  (`wifi help`, `ap help`, `jog help`, `node help`, `macro help`, …).
  noditron's identify probe now sends `
ping
` instead of `?
ping
`
  (serialConsole.PROBE_BYTES). State at hand-over: the CNC upload to COM8
  failed with "could not open port" (something on the PC holds COM8 — the
  browser's Connect (COM), most likely); the S3 OTA to 192.168.1.174 went
  out, the board rebooted and its AP LOGICMOD-48C4 is up, but it had not
  rejoined DHLAN minutes later (not in `/api/discover`, no ping). Check it
  on USB or its AP (192.168.0.1: `wifi status`, `wifi on`), then re-verify
  `help`, `wifi help`, `name`; then flash the CNC once COM8 is free.
- **noditron served by the Logic Module itself (S3 build 20260927c,
  2026-09-27).** `node tools/build-board-site.mjs [--upload <host>]` gzips
  noditron's client (root), nodigraph's client (under nodigraph/, minus
  tests/tools/screenshots/sw.js/privacy/index) and the bundled modules as
  JSON (api/modules.json, api/modules/<name>.json) into conucon's
  modules/esp32_logic/data/site/ (114 files, 1.9 MB -> 628 KB); --upload
  POSTs each file to the board's /files (its upload handler now makes the
  parent directories) so the rest of its flash — wificonfig.json, the
  design — stays. Firmware: `serveSiteFile()` maps any GET to
  /site<path>.gz (Content-Encoding by streamFile), `/` is noditron when
  /site/index.html.gz exists, the old belts editor stays at /logic-editor;
  `/api/project` GET/PUT keeps /project.json; `/api/modules` and
  `/api/modules/<name>` are the JSON files; `/api/discover` lists the nodes
  heard on the network (their hello ip), so the Add Block window's Connect
  IP works from the board. Not on the classic DevKit: its LittleFS is
  128 KB (min_spiffs.csv). Limits: Web Serial needs a secure context, so
  from http://<board>/ only Connect IP works (no USB); nodigraph's liveSync
  retries a WebSocket to port 80 every second (the board's WS is :81) and
  gets 404s — harmless; Google Fonts fail offline (fallback fonts); PUT
  /api/project holds the whole body in RAM. Tests:
  tools/board-site.test.mjs (79 pass in all).
- **Radio toggles that come back on their own (classic DevKit):** `ap off` /
  `wifi off` are saved (writeWifiConfig) and applied (applyWifiModeSoon);
  nothing in the firmware switches them back. The dialog's checkboxes
  follow `wifi status` every 10 s, so a box that re-checks itself means
  the board reloaded its saved state — a reboot (the DevKit's brownout as
  the radio starts) or a save that failed (the shell box would show
  "error: could not save"; the DevKit's 128 KB filesystem needs a LittleFS
  format if it ever held SPIFFS). Check /api/version's uptimeMs after a
  toggle. The single radio also explains its bad WiFi: AP+STA share one
  channel, the AP restarts whenever the station rejoins, and modem sleep
  is on (no WiFi.setSleep(false)).
- **Embedded build of the board-served page (2026-09-27, the default of
  `tools/build-board-site.mjs`; `--full` is the old whole site).** Same
  nodigraph editor, but: no Google Fonts (they blocked rendering for
  seconds on a board's own AP) — `client/embedded.css` sets the system
  font and a plain flow layout (static top bar, canvas, static bottom
  bar; #search-box/#online-users/#doc-sync/#file-source hidden); no
  installable-app files (icons, manifest, sw.js) and no live-sync
  WebSocket retries — `window.nodigraphEmbedded = true` is set in the
  board's index.html before any module, and nodigraph's main.js skips
  connectLiveSync/registerServiceWorker/consumeLaunchFiles on it (the one
  nodigraph change, a host hook like the others); no esptool bundle — the
  embedded build serves `client/vendor/esptool-js/esptool-js.embedded-stub.js`
  under the bundle's name (a page over plain HTTP has no Web Serial
  anyway); the Add Block window hides Connect USB and offers only the
  kinds the firmware runs (`EMBEDDED_KINDS` in addBlockDialog.js: no
  Weather/LED/JSON Field). 110 files, 1.7 MB -> 532 KB. `embeddedIndex()`
  transforms client/index.html at build time and throws if its shape
  changed. Tests: tools/board-site.test.mjs (81 pass in all; nodigraph's
  own 88 pass).
- **`?` as a shell line = the node's state (CNC 20260927f, S3 20260927e).**
  On the CNC it is grbl's status report (same as `status`; on its USB
  console the byte is still realtime, so `node esp32-s3 ?` typed there
  loses the `?` — grbl semantics); the S3 prints
  `<name|circuit:…|blocks:n|sta:ip|ap:on|heap:n>`.
- **CNC WiFi restart no longer blocks the bus task**: `wifi_config.begin()`
  runs on its own task (`wifiApplyTask`, Module.cpp) — grbl's StartSTA
  waits up to 10 s for the join, and module_poll ran it in clientCheckTask,
  which also reads CAN: every bridged `node CNC …` during a join was "no
  reply". This was the cause of the dialog's WiFi checkbox "coming back":
  `wifi off` → S3 timed out → the dialog re-read `wifi status` → still on.
- **CAN watchdog (both firmwares)**: error-passive (a counter >= 128) for
  3 s → driver uninstall + install, at most every 30 s (`can_watch` in the
  CNC's Serial.cpp, `canWatch` in the S3's main.cpp; the S3's install is
  now `canInstall(tx, rx, bitrate)`). A first version also restarted on a
  "stuck" TX queue — wrong: the CNC mirrors every console line onto the
  bus, so its queue is always full, and the restarts every 3 s broke the
  bus for the S3.
- **Bus state at hand-over**: after the CNC's last reflash the bus is dead
  again — CNC sees a silent bus (tec 0, rec 0, bus_errors 0, hears no
  hello, its TX queue never drains), S3 has tec=128 (its frames get no
  ACK) with bus_errors climbing. Both ends restarted their drivers; no
  change. Bitrate/pins verified equal. It worked for a while between the
  S3's OTA reboot and the CNC's 20260927d reflash. Looks physical on the
  CNC's side (transceiver / CAN_H-CAN_L / termination) — the user said to
  stop chasing it (the page goes over WiFi, not CAN).
- Open question from the user: a greyed "settings" button in a nodigraph
  selection menu. Not identified: the amber ⚙ (noditron's
  nodigraphSelectionFab, "Edit value") is hidden, never greyed, when the
  block has no dialog; #inspector-toggle is `disabled` until a block is
  selected; nodigraph's main.js creates #search-box/#file-source itself
  when the host page lacks them (checked: no null error). Ask which one.
- **Embedded build, lighter still (2026-09-27, after "wire routing is
  luxury"):** measured first — 532 KB gz spread thin (DragStateMachine 33,
  BlockRenderer 29, main 29, SubPreviewRenderer 13, ConnectionRenderer 12
  KB gz), routing code < 10 KB, so bytes were not the weight; runtime
  was. Behind `window.nodigraphEmbedded` now: no obstacle routing or
  channel fan-out (ConnectionRenderer returns the plain port-to-port
  route), no wire-piece dragging (DragStateMachine.startWirePieceDrag
  returns false), no nested level previews (SubPreviewRenderer.isLevelOpen
  false: a container is closed until entered), no 1 s cursor-fade redraw
  (nodigraph main.js), and noditron's 100 ms runtime tick redraws only
  when some block's outputs changed (main.js outputsChanged). Flow
  animation is off by default already. nodigraph 88 / noditron 81 tests
  pass. Further cuts would need bundling/tree-shaking (no minifier in the
  repos) or a fork; the next real weight is BlockRenderer's face drawing.
- **noditron on the classic ESP32 DevKit: it fits (2026-09-27).**
  conucon `modules/esp32_logic/partitions_4mb_site.csv`, now the `release`
  env's table: 2 x 1.44 MB app (OTA kept) + 1 MB LittleFS (+ nvs/otadata/
  coredump). Classic firmware 970 KB, embedded site 545 KB gz. Not flashed
  (no DevKit on USB); flashing the new table erases the filesystem
  (wificonfig.json, design.json) — afterwards `node tools/build-board-site.mjs
  --upload <ip>` (~10 min at LittleFS speed). The classic link had failed
  first (dram0 overflowed by 3.6 KB): `designBuf` (16 KB, the design-save
  buffer) is on the heap now, taken on first use (`designBufReady()`);
  static RAM 111.8 KB. Largest remaining statics: `cb` 51.7 KB (circuit
  blocks), `jj`/`bb` 3 KB each, knownNodes 1 KB. No PSRAM on the DevKit:
  `PUT /api/project` holds the whole body in a String — a project past
  ~100 KB may fail there; streaming the body to the file is the fix if it
  bites. The S3 firmware was not rebuilt after the designBuf change (same
  source; rebuild + OTA at the next change).
- **CNC 20260927g: the WiFi restart no longer runs on its own task** (that
  crashed — LoadProhibited — racing grbl's web services on `wifi on`);
  instead grbl's `WiFiConfig::ConnectSTA2AP` never waits for the join
  (it polled up to 20 s from clientCheckTask), so `wifi on`/`off` answer at
  once and the bus task keeps running. Verified over USB: toggles, no
  crash, rejoined DHLAN. **CNC dialog: one radio group** (Access point |
  WiFi) instead of two checkboxes — `build-esp32-cnc-module.mjs` rewrites
  the S3 section's `box.type = 'checkbox'` to a radio named cnc-radio; the
  S3's own handlers serve unchanged. Bus at hand-over: CNC hears the S3
  (`nodes=1`, rec=128), S3 still tec=128 / no reply — the user said to
  leave CAN alone.
- **The board-served page is one script and one stylesheet (2026-09-27).**
  Over the AP the page failed with "Expected a JavaScript module ... MIME
  type text/html": an earlier --upload had stopped after 87 of 110 files,
  so nodigraph/src/ui/*.js, version.js, nodigraph/styles.css and vendor/
  were missing and the firmware's not-found 302 handed index.html back
  for each import. Beyond that, 98 module requests queue on the WebServer's
  single connection at ~0.15 s each whatever the size, so the count was
  the load time. `tools/build-board-site.mjs` now bundles with esbuild
  (devDependency in the new root package.json; `npm install` once): the
  three `<script type="module">` tags of index.html become one entry in
  document order (registerExtraTabs, nodigraph main, noditron main, so
  window.nodigraphExtraTabs is still set first), noditron's absolute
  `/nodigraph/...` and `/src/...` imports are resolved by a plugin to
  the two checkouts, the esptool bundle is swapped for its stub in the
  embedded build, dynamic import()s are inlined; the three stylesheets
  become app.css. Whitespace/syntax minified, identifiers kept. Site now:
  index.html, app.js (143 KB gz), app.css, nodigraph/icon.svg, api/
  modules.json + api/modules/<name>.json — 8 files, 230 KB gz (was 110
  files, 532 KB). peerjs, icons, manifest and the licences only in --full.
  Block code that lives in strings (palette.js, the esp32-devkit and S3
  manifests) used `await import('/src/serialConsole.js')` and
  `import('/nodigraph/src/model/BlockDescription.js')` at run time —
  URLs the board no longer has; noditron's main.js now sets
  `window.noditronModules = { serialConsole, BlockDescription }` and the
  strings read from it. Checked in headless Chrome against a stub server
  (page boots: window.nodigraph, canvas, 6 fabs, 4 requests) — the board
  and the live noditron server were not touched. Not yet uploaded to the
  S3 (the assistant's upload was blocked): `node tools/build-board-site.mjs
  --upload 192.168.1.174`. The 110 old files stay on its flash unused
  (~530 KB of 10 MB; an FS image would wipe wificonfig.json, so leave
  them or delete via /files?action=delete). Next win: the firmware sends
  Cache-Control: no-cache with no ETag, so every visit re-downloads
  app.js; a content hash in the name plus a long max-age in serveSiteFile
  would make repeat loads free. Tests: tools/board-site.test.mjs rewritten
  (async siteFiles, siteIndex). Uploaded 2026-09-27 and verified
  byte for byte over LAN (~0.5 s for the four page requests). First load
  over the AP then died on `crypto.randomUUID is not a function`: the
  headless check had run on localhost, a secure context, while
  http://192.168.0.1/ is not — nodigraph main.js now falls back to
  getRandomValues. Test the board page from a LAN-IP origin, never
  localhost (clipboard, file pickers and Web Serial are missing there
  too; those only fail on use and Web Serial is guarded).
- **The board's own page opens as the board (2026-09-27, `client/src/
  boardPage.js`, run from main.js before the reconnect cards when
  window.nodigraphEmbedded).** The user: "since we are in the esp32-S3,
  the module shall be always there and it is default (not block a,b,c);
  the circuit shall be loaded". At boot the page asks its own /api/version
  (same origin); a Logic Module's answer names the node. The block with
  that nodeId is found (devkitCircuit.collectBoardBlocks), or placed from
  the module the board is (moduleNameForBoard: esp32-s3-devkit for a
  logic board over the network, esp32-devkit when it calls itself esp32,
  esp32-cnc by type) after nodigraph's example (exactly Block A/B/C at
  the root, untouched) is removed — anything the user drew stays. Then
  the reconnect card's steps without the card: serialFlash.connectWifi
  to location.hostname (not .host — the WS has its own port 81),
  serialConsole.identify, connectionState, deviceSync.reconcileWithDevice
  (an empty block takes the device's design.json), then
  nodigraph.enterBlock(board) — a new host hook on window.nodigraph, the
  double-click path (camera, breadcrumb, persist). A reload inside the
  board stays there. A board that does not answer leaves its block placed
  and "Not connected"; the enter is then refused by noditron's own
  nodigraphCanEnter (a board is entered only while running), which opens
  its dialog. The project, block included, is persisted by nodigraph's
  store.js to the board's /api/project, so the next visit finds the
  block and only reconnects. Note: the S3's ping prints
  `[INFO] node=… type=logic sta=…` (no name=), so identify's node
  regex misses it — the nodeId comes from /api/version here. Verified
  in headless Chrome from a LAN-IP origin against a stub site server on
  :80 plus a stand-in console WebSocket on :81 (scratchpad serve.mjs /
  fake-board-ws.mjs pattern): opens inside esp32-S3, connected:running,
  "Loaded the device's circuit: 0 block(s), 1 wire(s)" for a DI1->DO1
  design, no errors. Uploaded to the S3. Tests: tools/board-page.test.mjs
  (7; 89 in all), nodigraph 88.
- **Save on the board's page stores on the board (2026-09-27).** The user
  changed the circuit, pressed Save, read "Saved in this browser" and took
  it as not sent. Two things were true: nodigraph's wording ignored what
  the host's before-save hook had done, and the board had in fact never
  stored the project — GET /api/project on the S3 held a 911-byte project
  with no blocks, the one persisted just before the board block was
  added. Measured with curl PUTs: /api/project takes 20 and 60 KB (204),
  a 120 KB body drops the connection (WebServer 2.0.9 reads the whole
  body into RAM through readBytesWithTimeout/realloc; no PSRAM flag on
  the S3 env); a project with the S3 block is ~113 KB (props plus their
  description). store.js swallowed the failures. Now: nodigraph's
  store.saveProject(project, { flush }) hands the shared write to
  window.nodigraphSaveProject when a host sets it and resolves to whether
  the write took; noditron's boardPage.installProjectStore sets it on
  the embedded page (before the first persist) and POSTs the project as a
  multipart upload of project.json to the board's /files — the handler
  that streams to LittleFS and already carried the 143 KB app.js — which
  is the same /project.json GET /api/project serves. Autosaves are
  batched (1.5 s after the last edit, newest wins; a beacon on pagehide),
  an explicit Save flushes at once; installBoardPage flushes after
  placing the block. handleSaveLocal returns { ok, message }: the message
  is what nodigraphBeforeSave returned — createDeviceSaver now resolves
  to "Circuit sent to <board names>." — and a host store that reports
  failure fails the Save ("Couldn't save: the device did not store the
  diagram"); AppMenu shows the host's message in place of "Saved in
  this browser". Verified headless from a LAN-IP origin against the stub
  site on :80 (now with /files and /save-design) and the stand-in console
  on :81 — both kept as tools/board-page-harness/ (usage in serve.mjs) — with a synthetic Ctrl+S: POST /files (project.json, 113 KB) at
  boot, then POST /save-design (401 B) and another /files on Save; the
  stored project holds esp32-S3 with the path inside it. Tests:
  tools/board-page.test.mjs (10; 92 in all), nodigraph 88.
- **A board's inside shows on its face again on the board page
  (2026-09-27).** The embedded trimming had SubPreviewRenderer.isLevelOpen
  return false outright, so from outside the esp32-S3 its circuit was
  never drawn at any zoom (reported: "cannot see the subnode regardless
  of how much I zoom"). Now the usual zoom rule applies there too and the
  saving is in depth instead: SubPreviewRenderer.maxDepth() is 1 on an
  embedded host (MAX_DEPTH 12 elsewhere), so the level on screen opens
  its blocks' faces but a level drawn inside a face keeps its own shut.
  First cut of that capped the depth from the root — but the scene draws
  the whole tree from the root even when you stand inside a block, so the
  board's own level (depth 1) was skipped and its inside showed as an
  empty frame with wire stubs (reported: "something is wrong with
  drawing"). Now SubPreviewRenderer.previewDepth() counts below the
  edited level (focus.pathIds.size); the levels on the focus path always
  draw. LevelFocus.resolveFocus descends no deeper than that. Checked
  with a headless screenshot from the LAN-IP harness (Match and Timer
  drawn inside the S3; the harness design.json now carries that circuit).
- **CAN neighbours placed automatically, everywhere (2026-09-27).** The
  user: "check for defined CAN modules (cnc, logic), automatically connect
  them to CAN and show their online status". The Add Block window already
  did this after a connect; the board page and the bridge poll did not.
  The neighbour logic moved out of addBlockDialog.js into
  `client/src/canNeighbours.js` (setBlockProp, findBoardByNodeId,
  canPortOf, wireCan, placeNeighbours, scanAndPlaceNeighbours,
  describeNeighbours; addBlockDialog re-exports wireCan/canPortOf). Three
  callers: addBlockDialog.identifyAndPlace; boardPage.connectBoard after
  the reconcile and before entering the board (its level is the one being
  edited then, so the paste lands beside it); canBridge.scanBridges, which
  now takes onNodes(board, nodes) — main.js wires it to placeNeighbours
  with an `offered` Set, so a module joining the bus later is placed at
  the next 10 s poll, once: a block deleted on purpose is not put back
  until a fresh connect or reload. Placement only while the board's
  level is on screen (from inside the board the poll waits). Online
  status is canBridge.refreshBridgedStates as before (connected:running
  through the bridge; the CNC pill reads "grbl running"). Tests:
  tools/can-neighbours.test.mjs (5; 97 in all). Headless screenshot from
  the harness (fake-board-ws now answers `nodes` with a CNC via can;
  serve.mjs clicks the root crumb at 7 s): S3 and CNC side by side, CAN
  wire, both running. **On the real bench the S3 answers
  `cnc 0dd04644 CNC v1.4 seen 0s ago via wifi`** — heard over the LAN
  hello, not the bus — so the CAN rule places nothing there until the bus
  carries hellos again (see the earlier bus notes: S3 tec=128, no ACK).
- **`via` flips between can and wifi on a board heard both ways
  (2026-09-27).** Sampled on the real S3: six `nodes` in three seconds
  gave can, wifi, can, can, wifi, can for the CNC — noteNode() overwrote
  `via` with whichever hello came last (both about once a second; the
  CNC hears the S3 `via can` steadily). So noditron's CAN rule was a
  coin flip per scan. Fixed on both sides. Page: canBridge.scanBridges no
  longer forgetBridge()s before noting (a wifi reading must not drop a
  node the last reading had on CAN; STALE_MS ages real departures out);
  canNeighbours.placeNeighbours counts a node the registry still has
  behind this board as CAN; scanAndPlaceNeighbours asks `nodes` a
  second time 1.2 s later when a module was reported over WiFi and takes
  either reply's CAN answer. Firmware (S3 build **20260927f**, built,
  bundled as firmware-assets/logic/esp32-s3-waveshare.bin, preset label
  updated): KnownNode gains lastCan; a hello over another transport does
  not demote `via` from can while the CAN hello is younger than
  CAN_VIA_STICKY_MS (10 s). Includes the earlier designBuf-on-heap change
  the S3 had not been rebuilt for. Flashed over WiFi with the user's go-ahead
  (`node tools/ota-upload.mjs 192.168.1.174 .../firmware.bin` in conucon,
  18.8 s, back in 12 s); afterwards three `nodes` samples in a row read
  `cnc 0dd04644 CNC v1.4 seen 0s ago via can`. The CNC firmware has the same
  last-wins `via`; it happens to read can for the S3 and was left alone.
  Tests: 99 pass.
- **Neighbours land on the board's level whatever is on screen
  (2026-09-27).** On the real bench the boot scan found the CNC
  (`via can`) but placed nothing: the page had reloaded inside the S3
  (persisted path), and placement waited for the board's level to be
  the one being edited — the CNC only appeared some polls after leaving
  the board ("why so late?"). canNeighbours.placeNeighbours now resolves
  the manifest first, then switches project.path to the board's level
  (pathToLevel) for the paste and the CAN wire and switches back in the
  same tick (onLevel: a proxy nodigraph with no-op selection/persist, one
  persist afterwards), so no frame sees the switch. Harness: boot twice
  against the stand-in board, the second time with the stored project
  inside the S3 and the CNC removed — the CNC is back, wired, at boot.
  Tests 100 (tools/waveshare-board.test.mjs now pins the preset label
  20260927f).
- **CNC `reset` left grbl Idle with homing enabled (2026-09-27).** The
  shell's `reset` is ctrl-x (Cmd::Reset → mc_reset → protocol loop
  exit → run_once). Grbl_Esp32's reset_variables() keeps the prior
  state, so only grbl_init() (power-up) applied HOMING_INIT_LOCK; the user
  expects a reset to come up locked like a boot. reset_variables() now
  sets State::Alarm when homing is enabled (Grbl.cpp, under
  HOMING_INIT_LOCK). CNC build **20260927h** built (`pio run -d
  modules/esp32_cnc -e release`, 1.17 MB); flashing over WiFi goes to
  grbl's /updatefw (WebUI/WebServer.cpp), e.g. `node tools/ota-upload.mjs
  192.168.1.171 modules/esp32_cnc/.pio/build/release/firmware.bin` —
  reboots the CNC. Flashed with the user's go-ahead (110 s upload, back in
  11 s, /api/version build 20260927h); `?` after boot: `<Alarm|...>`;
  `unlock` → Idle, `reset` → `<Alarm|...>` again.
- **"unlock" never reached the CNC; the page now says what the board did
  not get (2026-09-27).** The bench circuit inside the S3: DI1 → Match
  (routes 1,0); Match.1 → Data "unlock".in AND → Data "unlock".write;
  Data "unlock".out → Data (collector, value 0).write; Match.1 → the
  collector's write; collector.out → CAN. Compiled with the page's
  own compiler offline (strip-harness, project pulled from the board):
  serialConsole.collapsePassThroughs treats any Data fed through `write`
  as a plain junction (what is written passes to out), so both Data
  blocks vanished and the design was din → croute → belts → can: route 1
  sends its own value to CAN, "unlock" is never sent — and deviceSync
  said "The device holds this circuit -- nothing to save", which was
  true of the design. The shape that works (compiled and checked):
  Match.1 → Data "unlock".in, Data.out → CAN; nothing into write, no
  collector (a collector fed only through write is a harmless junction).
  Now buildMinimalDesign(childBlocks, connections, notes) collects a line
  per drawn block the design leaves out (a write-fed Data that holds a
  value: "…plain junction…never sent…wire the trigger into in"; anything
  else wired but without a row: "…no layout for…"); threaded through
  devkitCircuit.buildDevkitDesign(esp, level, { notes }); createDeviceSaver
  appends "Not on the board: …" to the Save toast and
  deviceSync.reconcileWithDevice to its in-sync/differs messages. Tests:
  tools/compile-notes.test.mjs (4; 104 in all). Also: the inner wires on
  the board page are the browser's simulation, not the board's
  traffic — a Data's out carries its value every tick (harness: both
  Data wires read #3ecf5d with no input at all), so nothing there
  "becomes" green on a trigger; the board reports pins only (io-change).
- **Repeated `io` snapshots (2026-09-27).** ioDirty is set by every dout
  delivery whether the value changed or not, so the page heard the full
  "io" line again and again; in the bench log most were real changes (the
  Timer toggles DO1 every second, io-change and then io for the same
  edge). broadcastIO() now skips a snapshot identical to the last one
  sent (lastIoJson; force on connect is still available). S3 build
  **20260927g** built and bundled (preset label and test moved to g);
  flashed over WiFi with the user's go-ahead.
- **The write-port note now names the wire (2026-09-27).** The user read
  the first wording and did not get it — their model of Data (in: the
  stored string goes out; write: the stored string becomes what was
  written and goes out) is the browser's DATA_FN exactly. The gap is the
  board: the firmware's data block (main.cpp, deliverToBlocks
  `"data"` → circuitFireAll(dataVal)) fires its stored value on any
  input and has no write input; a belt reaching it from any side is the
  trigger, so a real write would need a distinguishable input in the
  grid model, plus compiler and designImport work — not done. The note
  now reads: `Data "unlock": the board's Data block has no write input,
  so with Match.1 wired into write the board passes that value through
  instead of sending "unlock". Remove the wire into write; a wire into in
  triggers "unlock".` Tests 104. Uploaded.
- **Data `write` on the board (2026-09-28).** The user: the Data block
  works like this — in: the stored string goes out; write(string1): the
  stored string becomes string1 and goes out — "just change the
  firmware". Firmware (S3 build **20260928a**): a `data` block two or
  more rows tall has a write input — deliverToBlocks sends a belt landing
  on any row below its top row to circuitRecv(port 1), which stores the
  value in dataVal and fires it; the top row (and a one-row block) is the
  trigger as before. Compiler (serialConsole.buildMinimalDesign):
  collapsePassThroughs no longer folds a written Data into a junction;
  a Match chain may end in a Data through its write port (a collector),
  placed as the chain's sink at (9, top-1), h = trigger row + one row
  per chain row, its out → belt (11) → the Output pin at (12); writer
  rows for a Data written by an Input pin / Timer / a Data one of those
  triggers, with an optional trigger on the top row, sources two rows
  apart (they are 2 x 2 and fire every belt along their edges), the
  written Data spanning down to the last writer's row, its out → sink
  at (9, base); the older one-row "source → Data.in → output" shape and
  the boot-constant shape skip a written Data. Importer (designImport):
  a belt on a lower row of a data block with h ≥ 2 is a wire into
  `write` (the port is unhidden). Note: default block size is 2 x 2 (a
  data block emitted without h is two rows tall) — every existing layout
  lands its belt on the top row, so nothing old changes meaning. The
  bench circuit now compiles to din → croute → data "unlock" → collector
  (h3) → can, and "unlock" reaches the CNC; the stray Match.1 → "unlock".write
  wire has no belt (a Data both triggered and written on one route keeps
  the trigger). Tests: tools/compile-notes.test.mjs rewritten (6, with an
  import round trip); firmware bundled, preset/test labels 20260928a. Two
  notes name the bench's stray wires ("A second wire from Match.1 into
  Data is not on the board: one row per route…" and "Match also writes
  Data; that wire is not on the board, the block already has its row").
  tools/waveshare-board.test.mjs's two pass-through tests moved to the
  new shapes (DI1 → write → DO2 is a writer row; a Data triggered and
  written from one route keeps both Data rows). 106 tests. Page uploaded;
  S3 flashed to 20260928a over WiFi (the user's "just change the
  firmware"). The board still runs the old design until the next Save.
- **Proved end to end: DI1 → "unlock" over CAN → CNC unlocks (2026-09-28).**
  The user: "JUST SEND THE STRING VIA CAN. CHECK IT. PROVE IT. Simulate
  that you press DI1." Two more firmware changes. S3 build **20260928b**:
  shell `din <gpio> <0|1>` feeds an input through the running circuit as
  if the pin had read it (same path as tickCircuit's confirmed
  debounce: dinLast, dynPins, ioDirty, circuitFire); the pin itself is
  untouched, so the next real read that differs releases it. First run
  showed the text arriving but as gcode: the CNC console printed
  `error:9` (gcode locked in Alarm) and the S3 got it back as can_in —
  the CNC's u2_recv fed every CAN/UART2 line to grbl unless it began
  with `socket `. CNC build **20260928a**: module_is_shell_line() (first
  word in HELP) and u2_recv runs such a line in the module shell
  (CLIENT_SERIAL, same task as the USB console) — `unlock` → $X — for
  CAN and UART2 sources, never for lines the shell itself feeds (SHELL).
  Both flashed over WiFi. Proof over the boards' HTTP shells: CNC
  `<Alarm|…>`; S3 `din 4 1` → `[DIN] gpio=4 state=1 fired 1 block(s)`;
  CNC `<Idle|…>`; CNC `reset` → Alarm; S3 press again → Idle. The
  user's design on the board (after Save): din@0,1 → croute@3,1 h2 →
  data@6,1 "unlock" → data@9,0 h3 (collector, written on row 1) → can@12,0.
  A WebSocket tap of both consoles (node, ws from noditron/server) is the
  way to watch the bus: S3 broadcasts can_in, CNC its console lines.
- **CNC pins are board settings; the web UI shows and applies them
  (2026-09-28).** The GUI's UI.PIN.* entries (gui.html
  LOCAL_UI_SETTING_DEFINITIONS, defaults 4..9) were browser-only and never
  reached the board; the real pins were compile-time in Machines/3axis_v4.h
  (X 33/25/34, Y 26/27/35, enable 13). CNC build **20260928b**: IntSettings
  Pins/{X,Y,Z}/{Step,Dir,Limit} and Pins/Stepper/Disable (EXTENDED, -1 = none,
  defaults = the machine file, checkers refuse flash/UART0/nonexistent
  pins and input-only 34-39 for outputs → error:81); Motors.cpp
  settingStepper() builds the X/Y/Z standard steppers from them (Z only when
  the build has >= 3 axes), the enable pin is read at init, Limits.cpp
  limits_init fills limit_pins[axis][0] from them. Applied at boot. GUI:
  PIN_SETTING_DEFINITIONS replace UI.PIN.* (same groups/labels, limit badge
  kept), `$Pins` requested with `$Homing`, and saving a pin schedules
  `$System/Control=RESTART` 2.5 s after the last pin save. GUI gzipped by
  tools/build-gui-gz.js into Grbl_Esp32/data/index.html.gz (embedded in the
  image). Flashed over COM8 (CH340) — **that is a second CNC board**, node
  bdd84084, MAC 58-2A-BD-D8-40-85, AP "CNC" 192.168.0.1; the CNC on the CAN
  bus (node 0dd04644, MAC 20-50-0D-D0-46-45) still runs 20260928a. Verified:
  $Pins lists the machine pins; Y limit -1 + restart → boot log has no Y
  limit; back to 35 → "Y Axis limit switch on pin GPIO(35)".

## One shell grammar on both boards: settings tree, `id@port>` traffic (2026-09-28)

CNC build **20260928c** and S3 (esp32_logic) build **20260928c**. The shell
changes on both boards:

- **The CNC no longer mirrors its console onto CAN.**
  - A line that arrives over CAN runs as grbl client `CLIENT_CAN` (5), so its
    `ok`, `error:` and `<Idle|…>` go back on the bus and nowhere else.
  - The console reaches the bus only with `can mirror on`.
- **Neither board echoes what it sends.**
  - `[CAN] tx` / `[CAN] rx` are only shown with `can log on`, a setting on
    both boards.
  - What reaches a node from another shows on its console as
    `<from>@<port>><text>`: `logic@can>unlock`, `cnc@can>ok`, `?@uart2>…`.
    `<from>` is the one node heard lately, else `?`.
  - A node request for this node shows as `<asker>@can><line>`.
  - The S3's `can_in` WebSocket message now carries `from`, and
    `wifiTransport.consoleTextFor` turns it into the same line.
- **Sending with `<node>@can><line>` (or `<node>><line>`).**
  - It runs the line on that node over CAN. The answer is printed as
    `<node>@can>…`, followed by its closing `ok` / `error:` without the
    prefix, so `shell()` still sees the end of the reply.
  - `<node>@socket><text>` puts text into the sockets on the bus.
  - `node <node> <line>` is unchanged; noditron's bridge still uses it.
- **Settings tree (see conucon esp32_cnc README, "Settings tree").**
  - `ls`, `ls x`, `x limit pin`, `x limit pin 34`, `x.limit.pin = 34`,
    `get …`, `set …`.
  - On the CNC the tree is grbl's settings list, each name turned into a
    path (`Pins/X/Limit` → `x.limit.pin`), plus per-axis mask bits
    (`x.dir.invert`) and live values (`x.limit.state`, `x.pos`). `$…` is
    unchanged.
  - On the S3 it is a table: `name`, `ap.*`, `wifi.*`, `can.*`,
    `circuit.*`, `firmware.*`, `heap`.
- **Removed lines.** grbl's `[RX:…]` echo now goes to the WebUI terminal only,
  and `[BUF:n]` after every `ok` is gone (nothing read either).
- **S3 line buffer.** The S3's USB line buffer grew from 48 to 256 characters.
- **noditron.** `ANNOUNCEMENT_RE` now matches any `<id>@<port>>` line as
  unsolicited, and a test covers it.
- **`ok` names the command it ends (both boards, 20260928c).**
  - The format is `ok G0 X10` / `ok ls can` / `ok unlock`. Commands longer
    than 48 characters are cut: `ok G1 X10 Y20 ...`.
  - It is still the reply terminator, so `shellCommand` accepts `ok` or
    `ok <anything>` and returns it as `end`, and the bridge passes the far
    board's own terminator on.
  - gui.html settles the waiter whose command the `ok` names (falling back to
    the oldest). Over HTTP it registers the waiter before reading the body,
    and drops a body `ok` nobody waits for.
  - Removed `ok`s:
    - the ones synthesized for realtime bytes and ABORT over UART2/CAN
    - the second `ok` from `$V=`
    - JMP's `ok:` / `error:` text plus status (now a `[MSG:JMP …]` line)
