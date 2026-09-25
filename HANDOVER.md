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
