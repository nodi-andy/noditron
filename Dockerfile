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

# Vendor nodigraph's client read-only, the same way local dev points at a
# sibling checkout (see server/src/app.js's own NODIGRAPH_CLIENT_DIR) — a
# deployed container has no sibling repo of its own, so this pulls one at
# build time instead. A plain shallow clone of nodigraph's own default
# branch; pin a tag/commit here instead if noditron ever needs to freeze
# against a specific nodigraph version rather than floating with it.
RUN git clone --depth 1 https://github.com/nodi-andy/nodigraph.git /tmp/nodigraph \
  && mkdir -p /usr/src/nodigraph \
  && cp -r /tmp/nodigraph/client /usr/src/nodigraph/client \
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
