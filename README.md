# noditron

An intelligent-blocks environment built on top of [nodigraph](https://github.com/nodi-andy/nodigraph) — nodigraph's own client runs unmodified, vendored read-only, while this project adds a palette of blocks with real logic (`fn`), custom on-canvas rendering (`render`/`html`), and settings panels (`dialog`). See `client/src/palette.js` for the blocks themselves and `client/src/runtime.js` for how they're evaluated.

## Library modules

`palette.js` only ever ships noditron's own primitives (Bool, AND, LED, ...). Everything else — an ESP32 dev board, a CNC module, anything a third party builds — is installed at runtime from `client/src/library.js`'s "Add from library…" button instead, not hand-added to the palette.

A module is plain data, not code: its repo carries one `noditron.module.json` manifest whose `block` field is exactly nodigraph's own clipboard payload (see nodigraph's `client/src/model/clipboard.js`) — the JSON you get from copying a block you built by hand in the editor. So authoring a module is "build the block once in the app, copy it, paste the JSON into your repo," and installing it is nodigraph's own paste path run against a fetched payload instead of the OS clipboard:

```json
{
  "noditronModule": 1,
  "name": "esp32-devkit",
  "displayName": "ESP32 DevKit",
  "version": "0.1.0",
  "description": "...",
  "swatchColor": "#c98a2f",
  "block": { "format": "nodigraph/clipboard-v1", "blocks": [ /* one copied block */ ], "connections": [] }
}
```

No registry server of ours is involved: a module lives in a GitHub repo (public — tag it with the topic `noditron-module` to show up in the library dialog's own browsable list — or private), fetched through the GitHub Contents API, no publish step beyond pushing. A repo is a **catalog**, not a single module — `client/src/library.js`'s `discoverModules` looks for a manifest at the repo's own root (a repo that's nothing but this one module) *and* enumerates `modules/<name>/noditron.module.json` for every subfolder under `modules/` (a repo someone keeps dozens of custom modules in — add a new folder, it shows up, nothing to register). Both conventions are merged into one flat, filterable list; a repo can use either or both. Opening "Add from library…" loads that whole list up front across every tagged repo (the search box filters it client-side, no repeat network calls per keystroke); a private repo needs a personal access token first, entered once via the "Import from a repo / manage GitHub token…" subdialog and kept only in this browser's `localStorage` — the same token nodigraph's own "Open/Save to GitHub" already uses (shared key, set it in either place), never sent anywhere but `api.github.com`. That same subdialog also covers a repo/path not yet surfaced by discovery. (An earlier version of this fetched public repos only, through jsDelivr's GitHub CDN — dropped once it turned out every repo in this project except `nodigraph` itself is private, which jsDelivr can never read regardless of a token. An even earlier version assumed one module per repo — dropped once "dozens of custom modules" per repo turned out to be the actual, ordinary case.)

**Authoring one:** build the block by hand in the editor — its custom `fn`/`render`/`html`/`dialog` code included, via the Inspector's Logic tab (see `client/src/logicTab.js`) — select it, open the same "Add from library…" dialog, and use its "Export selected as a module" section: fill in a name/description/version and it downloads a ready-to-push `noditron.module.json`. No separate authoring format or tool to learn; the exported payload is produced by the same `serializeSelection` nodigraph's own Ctrl+C uses. Place the download at your repo's root for a single-module repo, or under `modules/<name>/` alongside others for a catalog.

`modules/esp32-devkit/` and `modules/esp32-s3-devkit/` in this repo are two working examples built this way — a blank ESP32 (or ESP32-S3) board with no ports yet (nothing is known about it until it's connected) and a real connect/flash dialog, each wired to only its own chip's firmware — see "Flashing firmware over serial" below. Both share one dialog script (see the block's `chipFamily` prop, which the script filters `helpers.serial.firmwarePresets` against) rather than two copies that could drift apart. This repo (`nodi-andy/noditron`) is also always part of the browse list — `library.js`'s `DEFAULT_REPOS` includes it outright, so its own `modules/` catalog shows up whether or not the repo carries the `noditron-module` GitHub topic (a repo-settings change with no API this project's tools can reach — add it by hand under Settings → General → Topics if you also want *other* people's search to find it, since `DEFAULT_REPOS` only ever applies to this app's own build, not a searcher's).

## Flashing firmware over serial

The ESP32 DevKit module's dialog connects over the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Serial) and flashes `.bin` files straight from the browser (Chrome/Edge desktop only), using [esptool-js](https://github.com/espressif/esptool-js) — Espressif's own official in-browser flasher, vendored unmodified at `client/vendor/esptool-js/` (see its own README there for how to update it). `client/src/serialFlash.js` is the thin wrapper around it (one connection session per block, so more than one board can be connected at once); `client/src/dialogSystem.js` exposes it to any block's dialog as `helpers.serial`, the same way `helpers.fetchJson` is generically available to any block's `fn` — nothing here is specific to ESP32 devices beyond the module's own dialog code.

The dialog's firmware combobox (shown once a connected board doesn't answer to its own console — see "Connecting to a running board" below) lists ready-to-flash release builds committed right in this repo (compiled from conucon's `esp32_logic`; see `client/src/serialFlash.js`'s `FIRMWARE_PRESETS`, offsets sourced from conucon's own `server.js` `FIRMWARE_TARGETS` map), filtered to the module's own `chipFamily`, fetched over the same authenticated GitHub Contents API as the library manager using the same shared token. They started out living in conucon itself and moved here since noditron and conucon are both private repos: one repo means a single token's read access covers both the library manager's modules and this firmware, rather than needing access to two.

Each preset is a **bundle**, not a single file — for the classic ESP32 preset: `firmware-assets/logic/esp32-bootloader.bin` (`0x1000`), `esp32-partitions.bin` (`0x8000`), the shared `firmware-assets/boot_app0.bin` (`0xe000`, chip-family-independent — the same file covers every target), and `firmware-assets/logic/esp32.bin` (`0x10000`), all written together in one `writeFlash()` call. This used to be app-image-only, on the assumption a board already had a bootloader and partition table from some earlier flash — a genuinely blank or fully-erased chip has neither, and app-only left it with nothing at `0x1000` for the ROM to hand off to, which reads back as an infinite `invalid header: 0xffffffff` boot loop. conucon's own local installer hit and fixed this exact bug once already (see the comment above `FIRMWARE_TARGETS` in its `server.js`) — always writing the full bundle is what it settled on, since rewriting an unchanged bootloader/partition table on a board that already had one is a harmless no-op. The ESP32-S3 preset is still app-image-only for now (that core builds its own bootloader per target rather than shipping one project-wide, and nobody's hit this on an S3 board yet) — fine over a board that already has a bootloader/partition table, not yet a from-scratch blank-chip flash; a truly blank S3 needs those added as manual file rows, which is what the dialog's collapsed "Advanced" section is for — pick any `.bin` file(s) by hand, flash addresses auto-guessed from filename, editable.

## Digital I/O

One primitive covers what used to be two separate ones — Bool (a plain manual toggle, no pin) and Digital Input (a fixed, input-only GPIO reading) — plus the output direction neither had. Pick a pin (or "Simulated" for the old Bool behavior) and a direction in its dialog; switching direction is a real port swap (`out` for input, `in` for output — see `createDigitalIOBlock` in `client/src/palette.js`), including dropping any wire that pointed at whichever port direction switched away from, the same way the Inspector's own port-delete button does. It always simulates locally through its own value slider, connected to real hardware or not — `pin` is metadata read by whatever eventually sends this circuit to a board (see below), not a live hardware readout.

## Connecting to a *running* board

One connection covers the whole lifecycle — no separate network to join. `client/src/serialConsole.js` talks to conucon's `esp32_logic` over the *same* Web Serial connection `serialFlash.js` uses for flashing: once a chip is running actual firmware, plain bytes over that link reach the exact line-based command console it already runs during normal operation (see `pollSerialCommands`/`handleSerialCommand` in `modules/esp32_logic/src/main.cpp`) — `ping` identifies it, `design`/`save-design <n>` read and write its circuit, mirroring the HTTP `GET /design.json`/`POST /save-design` pair one-for-one but without ever needing this computer's WiFi on the board's own access point. Only the ROM bootloader (ESPLoader's own SLIP framing, used for flashing) and this plain console can't share the port's single reader lock at the same moment — `serialFlash.js`'s `reopenPlain`/`detectChip` close and reopen the same already-granted port to switch between the two, transparently, so nothing in a block's own dialog script has to manage that handoff itself.

The ESP32 DevKit module's dialog exposes one flow: **Connect (COM)** picks a port, then tries a `ping` on the console first — if firmware answers, you're straight into "Digital I/O" with a "Save changes to device" button; if nothing answers, it falls back to detecting the chip over the ROM bootloader and shows a firmware combobox (see "Flashing firmware over serial" above) to install from. Installing re-tries the console automatically once the board's had a moment to reboot. `helpers.console` is the generic bridge for this, exposed by `dialogSystem.js` the same way `helpers.serial` already is: `identify`, `readDesign`, `sendDesign`, `buildMinimalDesign`, `close`.

The on-canvas card (not just the dialog) shows which of three states the board is actually in, so checking doesn't mean opening the dialog every time: gray "Not connected" (nothing open), amber "\<chip\> — needs firmware" (a bootloader-detected board with no firmware answering yet) or "Connected — firmware unknown" (a stranger response to neither `ping` nor a bootloader probe), or green "Logic Module running" (the console's own `ping` answered). A second, separate line flags a circuit edited since it was last saved to the device, comparing a snapshot of the block's own children against the last one actually sent.

**What "Save changes to device" actually sends**, and what it doesn't: conucon's own circuit format is belts on a grid (Factorio-style signal routing — see `design.json`'s own shape), nodigraph's is named ports and point-to-point wires between arbitrary blocks. Translating actual *connections* between the two is real, separate work, not yet done. `buildMinimalDesign` in `serialConsole.js` only ever declares the pins themselves — one `din`/`dout` per Digital I/O block inside the ESP32 DevKit with a real pin set, unconnected. A design that needs actual routing between those pins still has to be finished by hand in conucon's own GUI for now. WiFi/CAN/etc. as their own fixed hardware submodules alongside Digital I/O are future work, not yet started.

## Run it locally

```bash
git clone https://github.com/nodi-andy/noditron
git clone https://github.com/nodi-andy/nodigraph ../nodigraph   # sibling checkout, read-only
cd noditron/server && npm install
node src/app.js
```

Then open `http://localhost:8090`. `NODIGRAPH_CLIENT_DIR` overrides where nodigraph's client is read from if it isn't a sibling directory; `PORT` overrides the port.

### Deploy

The `Dockerfile` at the repo root builds and serves the whole app — it vendors nodigraph's client at build time (no sibling checkout needed in production) via a shallow clone from GitHub. For Cloud Run:

```bash
gcloud run deploy noditron --source . --region <region> --allow-unauthenticated
```

The server listens on `PORT`, which Cloud Run sets automatically.

**The Dockerfile disables server-side persistence by default** (`NODITRON_DISABLE_PERSISTENCE=true`) — a container built from it never keeps a project in its own memory across requests. This matters because that state is a single variable shared by every request the process handles: without this, every visitor to a shared deployment would silently read and write the *same* diagram. That's fine for the "Run it locally" case above, where you're the only one who can reach the server at all — it's never fine for a container anyone on the internet can open. Only unset or override this variable for a deployment you're certain is single-user and not publicly reachable.
