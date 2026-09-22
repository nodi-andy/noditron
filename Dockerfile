FROM node:20-alpine

# git is needed only to vendor nodigraph's client below — not a runtime
# dependency, but alpine's base image doesn't include it.
RUN apk add --no-cache git

WORKDIR /usr/src/app

# Install server dependencies first so this layer is cached across
# client/nodigraph-version-only changes.
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server

# Bundle noditron's own client + server source.
COPY client ./client
COPY server ./server

# The bundled module catalog (modules/NAME/noditron.module.json), served by
# the server's own /api/modules off disk — see app.js's MODULES_DIR. Easy to
# overlook because nothing here imports it: it's read at request time, not
# build time, so leaving it out fails silently rather than breaking the
# build. readdirSync throws, the catch turns that into an empty list, and
# the library dialog just shows no modules at all — which is exactly how
# the ESP32 DevKit went missing from noditron.com while working in local
# dev, where the folder is simply there in the checkout.
COPY modules ./modules

# Vendor nodigraph's client read-only, the same way local dev points at a
# sibling checkout (see server/src/app.js's own NODIGRAPH_CLIENT_DIR) — a
# deployed container has no sibling repo of its own, so this pulls one at
# build time instead. A plain shallow clone of nodigraph's own default
# branch; pin a tag/commit here instead if noditron ever needs to freeze
# against a specific nodigraph version rather than floating with it.
#
# The ADD right before it is the cache-bust: a RUN instruction's cache key
# is its own literal text, which never changes here, so without this
# Docker (and Cloud Build/Kaniko) would happily keep reusing whatever
# nodigraph revision got baked into some earlier build's layer forever —
# "git clone the latest" is not actually latest if the layer is cached.
# ADD with a URL is the one instruction Docker always re-fetches rather
# than trusting its cache for, so this file only stays byte-identical
# (and the clone below only stays cached) for as long as nodigraph's main
# branch hasn't actually moved.
ADD https://api.github.com/repos/nodi-andy/nodigraph/commits/main /tmp/nodigraph-version.json
RUN git clone --depth 1 https://github.com/nodi-andy/nodigraph.git /tmp/nodigraph \
  && mkdir -p /usr/src/nodigraph \
  && cp -r /tmp/nodigraph/client /usr/src/nodigraph/client \
  && node -e "const fs = require('node:fs'); const cp = require('node:child_process'); fs.writeFileSync('/usr/src/nodigraph/build-info.json', JSON.stringify({ commit: cp.execFileSync('git', ['-C', '/tmp/nodigraph', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), builtAt: new Date().toISOString() }));" \
  && rm -rf /tmp/nodigraph

ENV NODE_ENV=production
ENV NODIGRAPH_CLIENT_DIR=/usr/src/nodigraph/client
# The public hosted product promises no server-side storage — see
# server/src/app.js's own PERSISTENCE_DISABLED (mirrors nodigraph's own
# Dockerfile/reasoning exactly: a plain `docker run` of this image must
# never turn into a single shared document every visitor reads and
# writes). Override to a falsy value only for a private, single-user
# deployment where that's actually wanted.
ENV NODITRON_DISABLE_PERSISTENCE=true
EXPOSE 8080

CMD ["node", "server/src/app.js"]
