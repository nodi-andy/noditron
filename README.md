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

`modules/esp32-devkit/` and `modules/esp32-s3-devkit/` in this repo are two working examples built this way — a blank ESP32 (or ESP32-S3) board with no ports yet (nothing is known about it until it's connected) and a real connect/flash dialog, each wired to only its own chip's firmware — see "Flashing firmware over serial" below. Both share one dialog script (see the block's `chipFamily` prop, which the script filters `helpers.serial.firmwarePresets` against) rather than two copies that could drift apart. They're only actually discoverable through the browse list once this repo carries the `noditron-module` GitHub topic — a repo-settings change with no API this project's tools can reach, so add it by hand under Settings → General → Topics if you want them to show up there; the manual-import subdialog installs either one regardless.

## Flashing firmware over serial

The ESP32 DevKit module's dialog connects over the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Serial) and flashes `.bin` files straight from the browser (Chrome/Edge desktop only), using [esptool-js](https://github.com/espressif/esptool-js) — Espressif's own official in-browser flasher, vendored unmodified at `client/vendor/esptool-js/` (see its own README there for how to update it). `client/src/serialFlash.js` is the thin wrapper around it (one connection session per block, so more than one board can be connected at once); `client/src/dialogSystem.js` exposes it to any block's dialog as `helpers.serial`, the same way `helpers.fetchJson` is generically available to any block's `fn` — nothing here is specific to ESP32 devices beyond the module's own dialog code.

The dialog's "Quick pick" row fetches ready-to-flash release builds committed right in this repo — `firmware-assets/logic/esp32.bin` and `esp32-s3.bin` (compiled from conucon's `esp32_logic`; see `client/src/serialFlash.js`'s `FIRMWARE_PRESETS`, offsets sourced from conucon's own `server.js` `FIRMWARE_TARGETS` map) — over the same authenticated GitHub Contents API as the library manager, using the same shared token. They started out living in conucon itself and moved here since noditron and conucon are both private repos: one repo means a single token's read access covers both the library manager's modules and this firmware, rather than needing access to two. Those are app-image-only (flashed at `0x10000`): fine for a board that already has *some* bootloader and partition table on it (a factory-fresh or previously-flashed ESP32 does), not yet a from-scratch blank-chip flash — there's no logic-specific bootloader/partitions.bin committed anywhere yet, only conucon's CNC-specific bootloader fallback and the chip-family-independent `boot_app0.bin`. You can still add those as ordinary manual file rows once they exist. Beyond the two presets here, pick any other `.bin` file(s) by hand — their flash addresses auto-guessed from filename, editable.

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
