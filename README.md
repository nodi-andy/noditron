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

No registry server of ours is involved: a module is just a public GitHub repo (tag it with the topic `noditron-module` to show up in search), fetched read-only through [jsDelivr's GitHub CDN mode](https://www.jsdelivr.com/documentation#id-github) (`cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/noditron.module.json`) — versioned by git tag, no publish step beyond pushing and tagging.

**Authoring one:** build the block by hand in the editor — its custom `fn`/`render`/`html`/`dialog` code included, via the Inspector's Logic tab (see `client/src/logicTab.js`) — select it, open the same "Add from library…" dialog, and use its "Export selected as a module" section: fill in a name/description/version and it downloads a ready-to-push `noditron.module.json`. No separate authoring format or tool to learn; the exported payload is produced by the same `serializeSelection` nodigraph's own Ctrl+C uses.

`examples/esp32-devkit/` is a working example built this way: a blank ESP32 board with no ports yet (nothing is known about it until it's connected) and a real connect/flash dialog — see "Flashing firmware over serial" below.

## Flashing firmware over serial

The ESP32 DevKit module's dialog connects over the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Serial) and flashes `.bin` files straight from the browser (Chrome/Edge desktop only), using [esptool-js](https://github.com/espressif/esptool-js) — Espressif's own official in-browser flasher, vendored unmodified at `client/vendor/esptool-js/` (see its own README there for how to update it). `client/src/serialFlash.js` is the thin wrapper around it (one connection session per block, so more than one board can be connected at once); `client/src/dialogSystem.js` exposes it to any block's dialog as `helpers.serial`, the same way `helpers.fetchJson` is generically available to any block's `fn` — nothing here is specific to ESP32 devices beyond the module's own dialog code.

Today you pick the `.bin` file(s) — bootloader/partitions/app, or a merged single image — and their flash addresses by hand (auto-guessed from filename, editable); conucon's `esp32_logic` and `esp32_cnc` firmware still need to be built locally with PlatformIO (`platformio.ini` in each module) since there's no published release build yet. Fetching the right prebuilt binary automatically once one exists is a natural next step on top of this.

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
