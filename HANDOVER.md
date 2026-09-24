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
