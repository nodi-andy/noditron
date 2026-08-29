# noditron

An intelligent-blocks environment built on top of [nodigraph](https://github.com/nodi-andy/nodigraph) — nodigraph's own client runs unmodified, vendored read-only, while this project adds a palette of blocks with real logic (`fn`), custom on-canvas rendering (`render`/`html`), and settings panels (`dialog`). See `client/src/palette.js` for the blocks themselves and `client/src/runtime.js` for how they're evaluated.

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
