// The library manager — noditron ships only the "primitives" in palette.js;
// everything else (an ESP32 dev board, a CNC module, ...) is a module a
// user finds and installs from here instead. A module is plain data: its
// manifest's `block` field is exactly nodigraph's own clipboard payload
// (see nodigraph's client/src/model/clipboard.js) — the JSON you get from
// Ctrl+C on a block built by hand in the editor. Authoring a module is
// therefore "build the block once, copy it, paste the JSON," not a bespoke
// format to learn — and installing one is nodigraph's own paste path run
// against a fetched payload instead of the OS clipboard. Nothing here is
// special-cased inside nodigraph; this only ever calls its public model
// API, the same rule every other file in this project follows (see
// palette.js's own doc on it).
//
// A repo is a *catalog*, not a single module — one manifest at its own
// root (a repo that's nothing but one module) plus any number more under
// modules/<name>/noditron.module.json (a repo somebody keeps dozens of
// custom modules in, adding a new folder whenever they build another one).
// Both conventions are discovered and merged (see discoverModules); a repo
// can use either, or both at once.
import { generateId } from '/nodigraph/src/model/Block.js';
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { pasteSelection, isClipboardPayload } from '/nodigraph/src/model/clipboard.js';
import { canonicalModuleName } from './moduleDiscovery.js';
import { getStoredToken } from '/nodigraph/src/model/githubSync.js';
import { rehydrateKindLogic } from './palette.js';

const GITHUB_API = 'https://api.github.com';
const MODULE_TOPIC = 'noditron-module';
const DEFAULT_MANIFEST_PATH = 'noditron.module.json';
const MODULES_DIR = 'modules';
const INSTALLED_PROP = 'noditronLibraryModules';
const SOURCE_PROP = 'noditronModuleSource';
const LOCAL_OWNER = 'local';
const LOCAL_REPO = 'bundled';
const LOCAL_REF = 'local';

// Always part of the catalog, whether or not it's tagged noditron-module —
// this repo already carries a modules/ catalog of its own (see
// modules/esp32-devkit/, modules/esp32-s3-devkit/). Only the local/bundled
// entry is listed here, not also 'nodi-andy/noditron' over the GitHub API —
// that's the exact same repo's exact same modules/ folder, so both used to
// discover and list every bundled module twice. local/bundled reads it
// straight off this server's own disk (see discoverModules below), no
// token or network round-trip needed, so it's a strict improvement, not
// just a dedup.
const DEFAULT_REPOS = [{ owner: LOCAL_OWNER, repo: LOCAL_REPO, defaultBranch: LOCAL_REF }];

// The GitHub Contents API, not jsDelivr's CDN — jsDelivr has no auth
// mechanism at all, so it can only ever reach public repos. This app's own
// repos (and plenty of real modules/firmware) are private, so anything
// meant to actually work needs a real, optionally-authenticated GitHub API
// call. Reuses nodigraph's own token storage (getStoredToken/setStoredToken
// — same key, same "kept only in this browser, sent only to
// api.github.com" posture as nodigraph's own GitHubConnectDialog) rather
// than inventing a second credential for the same account: set a token
// once, in either dialog, and both use it.
function authedHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `token ${token}`;
  return headers;
}

async function githubFetch(url, token) {
  const res = await fetch(url, { cache: 'no-store', headers: authedHeaders(token) });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const err = new Error(body?.message || `GitHub API error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0));
}

function base64ToText(b64) {
  return new TextDecoder().decode(base64ToBytes(b64));
}

function contentsUrl(owner, repo, path, ref) {
  const base = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
}

// GitHub's search API includes private repos the token's own account can
// see, same as browsing github.com signed in — so a token also turns this
// into "search my own private modules," not only the public ones anyone
// can find.
export async function searchModules(query, token = getStoredToken()) {
  const q = query && query.trim() ? `topic:${MODULE_TOPIC} ${query.trim()}` : `topic:${MODULE_TOPIC}`;
  const data = await githubFetch(`${GITHUB_API}/search/repositories?q=${encodeURIComponent(q)}&per_page=20`, token);
  return (data.items || []).map((repo) => ({
    owner: repo.owner.login,
    repo: repo.name,
    description: repo.description || '',
    defaultBranch: repo.default_branch,
    stars: repo.stargazers_count,
    htmlUrl: repo.html_url,
  }));
}

// The ref to fetch when the caller didn't pin one: the most recent tag if
// the repo has any (a real release), else its default branch (a module
// that hasn't cut a release yet still installs, just without a pinned
// version).
export async function resolveDefaultRef(owner, repo, token = getStoredToken()) {
  if (owner === LOCAL_OWNER && repo === LOCAL_REPO) return LOCAL_REF;
  const tags = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/tags?per_page=1`, token).catch(() => []);
  if (tags[0]?.name) return tags[0].name;
  const info = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}`, token);
  return info.default_branch;
}

function validateManifest(manifest) {
  if (!manifest || manifest.noditronModule !== 1) throw new Error('Not a noditron module manifest (missing noditronModule: 1).');
  if (!manifest.name) throw new Error('Manifest is missing a name.');
  if (!isClipboardPayload(manifest.block)) throw new Error('Manifest is missing a valid block payload.');
  return manifest;
}

function bundledModuleName(path) {
  const match = String(path || '').match(/^modules\/([^/]+)\/noditron\.module\.json$/);
  return match ? match[1] : null;
}

async function fetchBundledManifest(path) {
  const name = bundledModuleName(path);
  if (!name) throw new Error(`Unsupported bundled module path: ${path}`);
  const res = await fetch(`/api/modules/${encodeURIComponent(name)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Bundled module not found (${res.status})`);
  return validateManifest(await res.json());
}

// The Contents API caps a readable file at 1MB (base64 included) — plenty
// for a block manifest, whatever its embedded fn/html/dialog code; a
// module shipping something bigger than that inside its own JSON would
// need a different transport, out of scope here.
export async function fetchManifest(owner, repo, ref, path = DEFAULT_MANIFEST_PATH, token = getStoredToken()) {
  if (owner === LOCAL_OWNER && repo === LOCAL_REPO) {
    return fetchBundledManifest(path);
  }
  if (owner === 'nodi-andy' && repo === 'noditron' && bundledModuleName(path)) {
    return fetchBundledManifest(path);
  }
  const file = await githubFetch(contentsUrl(owner, repo, path, ref), token);
  if (Array.isArray(file)) throw new Error(`${path} is a directory, not a file.`);
  const manifest = JSON.parse(base64ToText(file.content));
  return validateManifest(manifest);
}

// Every module a repo carries, root single-module and modules/-directory
// catalog alike, merged into one flat list — the browse dialog never needs
// to know or care which convention a given repo actually used. Each
// candidate location is allowed to simply not exist (a repo using only one
// convention, or neither) without that counting as a real error; a
// manifest that exists but doesn't parse/validate is skipped rather than
// failing the whole repo's listing, since one broken module shouldn't hide
// every other one a large catalog carries.
export async function discoverModules(owner, repo, ref, token = getStoredToken()) {
  if (owner === LOCAL_OWNER && repo === LOCAL_REPO) {
    const res = await fetch('/api/modules', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn't load bundled modules (${res.status})`);
    const entries = await res.json();
    return (Array.isArray(entries) ? entries : []).map((entry) => ({
      owner: LOCAL_OWNER,
      repo: LOCAL_REPO,
      ref: LOCAL_REF,
      path: entry.path,
      manifest: validateManifest(entry.manifest),
    }));
  }

  const found = [];

  await fetchManifest(owner, repo, ref, DEFAULT_MANIFEST_PATH, token)
    .then((manifest) => found.push({ owner, repo, ref, path: DEFAULT_MANIFEST_PATH, manifest }))
    .catch(() => {});

  const dirListing = await githubFetch(contentsUrl(owner, repo, MODULES_DIR, ref), token).catch(() => null);
  if (Array.isArray(dirListing)) {
    const dirs = dirListing.filter((entry) => entry.type === 'dir');
    await Promise.all(
      dirs.map((dir) => {
        const path = `${MODULES_DIR}/${dir.name}/${DEFAULT_MANIFEST_PATH}`;
        return fetchManifest(owner, repo, ref, path, token)
          .then((manifest) => found.push({ owner, repo, ref, path, manifest }))
          .catch(() => {});
      }),
    );
  }

  return found;
}

function readInstalledModules(nodigraph) {
  const prop = nodigraph.project.rootBlock.props.find((p) => p.name === INSTALLED_PROP);
  if (!prop) return [];
  try {
    const list = JSON.parse(prop.value);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeInstalledModules(nodigraph, list) {
  const root = nodigraph.project.rootBlock;
  let prop = root.props.find((p) => p.name === INSTALLED_PROP);
  if (!prop) {
    prop = { id: generateId('prp'), name: INSTALLED_PROP, kind: 'value', value: '[]' };
    root.props.push(prop);
  }
  prop.value = JSON.stringify(list);
  root.description = serializeBlockDescription(root);
}

function recordInstalledModule(nodigraph, source) {
  const key = `${source.owner}/${source.repo}/${source.path}`;
  const list = readInstalledModules(nodigraph).filter((m) => `${m.owner}/${m.repo}/${m.path}` !== key);
  list.push(source);
  writeInstalledModules(nodigraph, list);
}

function registerLibraryModule(nodigraph, manifest, source) {
  recordInstalledModule(nodigraph, {
    ...source,
    name: manifest.name,
    displayName: manifest.displayName || manifest.name,
    version: manifest.version || null,
    swatchColor: manifest.swatchColor || source.swatchColor || '#8b93a3',
  });
  nodigraph.renderLoop.requestRender();
  nodigraph.persist();
}

export function getInstalledModules(nodigraph) {
  return readInstalledModules(nodigraph);
}

// Screen-center placement, same idea as palette.js's own viewCenter/
// nextPosition — a fresh block should land wherever the user is actually
// looking, not at whatever coordinates its source template happened to be
// drawn at originally.
function viewCenter(nodigraph) {
  const canvas = document.getElementById('scene-canvas');
  const rect = canvas.getBoundingClientRect();
  return nodigraph.camera.screenToWorld(rect.width / 2, rect.height / 2);
}

// Pastes the manifest's block payload into the level currently being
// viewed (pasteSelection already regenerates every id, so adding the same
// module twice in one project never collides — see clipboard.js's own doc
// on why that matters), re-centers the result under the current view, and
// tags each new top-level block with where it came from. Installing a
// library module is separate: registerLibraryModule records it in the
// palette without placing an instance.
export function addModuleBlock(nodigraph, manifest, source) {
  const newIds = pasteSelection(nodigraph.project, manifest.block, 0);
  if (!newIds.length) throw new Error('Nothing to install — the manifest had no blocks.');

  const blocks = newIds.map((id) => nodigraph.project.getBlock(id));
  const minX = Math.min(...blocks.map((b) => b.geometry.x));
  const minY = Math.min(...blocks.map((b) => b.geometry.y));
  const maxX = Math.max(...blocks.map((b) => b.geometry.x + b.geometry.width));
  const maxY = Math.max(...blocks.map((b) => b.geometry.y + b.geometry.height));
  const center = viewCenter(nodigraph);
  const dx = center.x - (minX + maxX) / 2;
  const dy = center.y - (minY + maxY) / 2;

  function hydrateNoditronLogic(block) {
    rehydrateKindLogic(block);
    if (block.children) {
      for (const child of block.children.blocks.values()) hydrateNoditronLogic(child);
    }
  }

  for (const block of blocks) {
    hydrateNoditronLogic(block);
    block.geometry.x += dx;
    block.geometry.y += dy;
    block.props.push({ id: generateId('prp'), name: SOURCE_PROP, kind: 'value', value: JSON.stringify(source) });
    block.description = serializeBlockDescription(block);
  }

  nodigraph.selection.select(blocks[0].id);
  nodigraph.renderLoop.requestRender();
  nodigraph.persist();
  return blocks;
}

export async function installFromRepo(nodigraph, { owner, repo, ref, path = DEFAULT_MANIFEST_PATH }) {
  const resolvedRef = ref && ref.trim() ? ref.trim() : await resolveDefaultRef(owner, repo);
  const manifest = await fetchManifest(owner, repo, resolvedRef, path);
  const source = {
    owner,
    repo,
    ref: resolvedRef,
    path,
    name: manifest.name,
    displayName: manifest.displayName || manifest.name,
    version: manifest.version || null,
    swatchColor: manifest.swatchColor || '#8b93a3',
  };
  registerLibraryModule(nodigraph, manifest, source);
  return { manifest, source };
}

// The module for a board that just identified itself (see
// moduleDiscovery.moduleNameFor), by name, from wherever it is: a module
// this project already installed, else one this server bundles (see
// server/src/app.js's /api/modules), else a GitHub repo tagged
// noditron-module that carries one of that name — installed on the way,
// so it is a plain tile in the Add Block window from then on.
export async function resolveModuleByName(nodigraph, name) {
  // A name from before the <hardware>-<firmware> scheme (older firmware,
  // older projects) is today's module of that name.
  name = canonicalModuleName(name);
  const installed = getInstalledModules(nodigraph).find((m) => m.name === name);
  if (installed) {
    return { manifest: await fetchManifest(installed.owner, installed.repo, installed.ref, installed.path), source: installed };
  }
  const bundledPath = `${MODULES_DIR}/${name}/${DEFAULT_MANIFEST_PATH}`;
  const bundled = await fetchBundledManifest(bundledPath).catch(() => null);
  if (bundled) {
    const source = {
      owner: LOCAL_OWNER,
      repo: LOCAL_REPO,
      ref: LOCAL_REF,
      path: bundledPath,
      name: bundled.name,
      displayName: bundled.displayName || bundled.name,
      version: bundled.version || null,
      swatchColor: bundled.swatchColor || '#8b93a3',
    };
    registerLibraryModule(nodigraph, bundled, source);
    return { manifest: bundled, source };
  }
  const repos = await searchModules(name).catch(() => []);
  for (const repo of repos) {
    const found = await discoverModules(repo.owner, repo.repo, repo.defaultBranch).catch(() => []);
    const hit = found.find((f) => f.manifest.name === name);
    if (!hit) continue;
    const ref = await resolveDefaultRef(repo.owner, repo.repo).catch(() => repo.defaultBranch);
    const source = {
      owner: hit.owner,
      repo: hit.repo,
      ref,
      path: hit.path,
      name: hit.manifest.name,
      displayName: hit.manifest.displayName || hit.manifest.name,
      version: hit.manifest.version || null,
      swatchColor: hit.manifest.swatchColor || '#8b93a3',
    };
    registerLibraryModule(nodigraph, hit.manifest, source);
    return { manifest: hit.manifest, source };
  }
  throw new Error(`no module named ${name}: not installed, not bundled with this noditron, and no noditron-module repo on GitHub carries one`);
}

// Every module this server bundles, as tiles for the Add Block window —
// the same source the resolver above reads, listed up front.
export async function listBundledModules() {
  const res = await fetch('/api/modules', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't load bundled modules (${res.status})`);
  const entries = await res.json();
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const manifest = validateManifest(entry.manifest);
    return {
      owner: LOCAL_OWNER,
      repo: LOCAL_REPO,
      ref: LOCAL_REF,
      path: entry.path,
      name: manifest.name,
      displayName: manifest.displayName || manifest.name,
      version: manifest.version || null,
      swatchColor: manifest.swatchColor || '#8b93a3',
    };
  });
}
