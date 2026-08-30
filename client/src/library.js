// The library manager — noditron ships only the "primitives" in palette.js;
// everything else (an ESP32 dev board, a CNC module, ...) is a module a
// user finds and installs from here instead. A module is plain data: its
// GitHub repo carries one `noditron.module.json` manifest whose `block`
// field is exactly nodigraph's own clipboard payload (see nodigraph's
// client/src/model/clipboard.js) — the JSON you get from Ctrl+C on a block
// built by hand in the editor. Authoring a module is therefore "build the
// block once, copy it, paste the JSON into a repo," not a bespoke format to
// learn — and installing one is nodigraph's own paste path run against a
// fetched payload instead of the OS clipboard. Nothing here is special-
// cased inside nodigraph; this only ever calls its public model API, the
// same rule every other file in this project follows (see palette.js's own
// doc on it).
import { generateId } from '/nodigraph/src/model/Block.js';
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { pasteSelection, isClipboardPayload, serializeSelection } from '/nodigraph/src/model/clipboard.js';
import { getStoredToken, setStoredToken } from '/nodigraph/src/model/githubSync.js';

const GITHUB_API = 'https://api.github.com';
const MODULE_TOPIC = 'noditron-module';
const DEFAULT_MANIFEST_PATH = 'noditron.module.json';
const INSTALLED_PROP = 'noditronLibraryModules';
const SOURCE_PROP = 'noditronModuleSource';

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

// The Contents API caps a readable file at 1MB (base64 included) — plenty
// for a block manifest, whatever its embedded fn/html/dialog code; a
// module shipping something bigger than that inside its own JSON would
// need a different transport, out of scope here.
export async function fetchManifest(owner, repo, ref, path = DEFAULT_MANIFEST_PATH, token = getStoredToken()) {
  const file = await githubFetch(contentsUrl(owner, repo, path, ref), token);
  if (Array.isArray(file)) throw new Error(`${path} is a directory, not a file.`);
  const manifest = JSON.parse(base64ToText(file.content));
  return validateManifest(manifest);
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
// viewed (pasteSelection already regenerates every id, so installing the
// same module twice in one project never collides — see clipboard.js's own
// doc on why that matters), re-centers the result under the current view,
// tags each new top-level block with where it came from, and records the
// module on the project itself so re-opening this project shows it as
// already installed.
export function installModule(nodigraph, manifest, source) {
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

  for (const block of blocks) {
    block.geometry.x += dx;
    block.geometry.y += dy;
    block.props.push({ id: generateId('prp'), name: SOURCE_PROP, kind: 'value', value: JSON.stringify(source) });
    block.description = serializeBlockDescription(block);
  }

  recordInstalledModule(nodigraph, source);
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
  return { blocks: installModule(nodigraph, manifest, source), manifest, source };
}

// --- UI ---

const HOST_ID = 'noditron-library-host';

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.hidden = true;
    document.body.appendChild(host);
  }
  return host;
}

function field(labelText, inputAttrs = {}) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:block;margin-bottom:10px;';
  const label = document.createElement('div');
  label.textContent = labelText;
  label.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin-bottom:4px;';
  const input = document.createElement('input');
  input.type = 'text';
  Object.assign(input, inputAttrs);
  input.style.cssText = 'width:100%;padding:6px 8px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:13px;box-sizing:border-box;';
  wrap.append(label, input);
  return { wrap, input };
}

function button(text, { primary = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.style.cssText = primary
    ? 'padding:6px 12px;border:1px solid var(--success,#3ecf5d);border-radius:6px;background:var(--success,#3ecf5d);color:#06210f;font-size:12px;font-weight:600;cursor:pointer;'
    : 'padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text-primary);font-size:12px;cursor:pointer;';
  return btn;
}

function heading(text) {
  const h = document.createElement('h3');
  h.textContent = text;
  h.style.cssText = 'margin:0 0 12px;color:var(--success,#3ecf5d);font-size:14px;letter-spacing:.03em;';
  return h;
}

function sectionLabel(text) {
  const div = document.createElement('div');
  div.textContent = text;
  div.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);margin:16px 0 8px;';
  return div;
}

function statusLine(text, isError = false) {
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText = `margin:8px 0 0;font-size:12px;color:${isError ? '#e5484d' : 'var(--text-muted)'};`;
  return p;
}

function slugify(name) {
  return String(name || 'module').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'module';
}

// Triggers a plain browser file save — no server, no clipboard permission
// needed, works the same way nodigraph's own "download" export options do.
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// The manual-import/token subdialog — everything a casual "browse and
// install" visit to the main dialog never needs to see. Its own host, not
// the main dialog's: opened on top of it rather than replacing it, so
// closing this one lands back on the list rather than nowhere.
const IMPORT_HOST_ID = 'noditron-library-import-host';

function ensureImportHost() {
  let host = document.getElementById(IMPORT_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = IMPORT_HOST_ID;
    host.hidden = true;
    document.body.appendChild(host);
  }
  return host;
}

export function installLibraryUI(nodigraph, onInstalled) {
  const host = ensureHost();
  const importHost = ensureImportHost();

  function close() {
    host.hidden = true;
    host.innerHTML = '';
  }

  function closeImport() {
    importHost.hidden = true;
    importHost.innerHTML = '';
  }

  // Import/token — a repo by name (with an optional pinned ref/path) and
  // the shared GitHub token, both things the plain browse-and-install list
  // in open() below never needs: most modules are public, and typing an
  // owner/repo is only for one you already know isn't (yet) listed.
  function openImport() {
    importHost.innerHTML = '';
    importHost.hidden = false;

    const backdrop = document.createElement('div');
    backdrop.className = 'noditron-dialog-backdrop';
    backdrop.addEventListener('click', closeImport);

    const panel = document.createElement('div');
    panel.className = 'noditron-dialog-panel';
    panel.style.minWidth = '380px';
    panel.addEventListener('click', (e) => e.stopPropagation());

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'noditron-dialog-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeImport);

    const body = document.createElement('div');
    body.className = 'noditron-dialog-body';
    body.appendChild(heading('IMPORT FROM A REPO'));

    // Shared with nodigraph's own "Open/Save to GitHub" — same storage key,
    // so a token set in either place works in both.
    const { wrap: tokenWrap, input: tokenInput } = field('GITHUB PERSONAL ACCESS TOKEN', { type: 'password', placeholder: 'ghp_…', value: getStoredToken() });
    body.appendChild(tokenWrap);
    tokenInput.addEventListener('change', () => setStoredToken(tokenInput.value.trim()));
    if (getStoredToken()) {
      const forgetBtn = button('Forget this token');
      forgetBtn.style.cssText += 'padding:2px 0;margin:-6px 0 14px;border:none;color:var(--text-muted);text-decoration:underline;';
      forgetBtn.addEventListener('click', () => {
        setStoredToken('');
        tokenInput.value = '';
        forgetBtn.remove();
      });
      body.appendChild(forgetBtn);
    }
    const tokenHint = statusLine('Only needed for a private repo — sent only to api.github.com, kept only in this browser.');
    tokenHint.style.margin = '-8px 0 14px';
    body.appendChild(tokenHint);

    const { wrap: repoWrap, input: repoInput } = field('OWNER/REPO', { placeholder: 'e.g. someone/esp32-devkit' });
    const { wrap: refWrap, input: refInput } = field('REF (optional — tag or branch, latest tag if blank)');
    const { wrap: pathWrap, input: pathInput } = field('MANIFEST PATH (optional)', { placeholder: DEFAULT_MANIFEST_PATH });
    body.append(repoWrap, refWrap, pathWrap);

    const fetchBtn = button('Fetch');
    const previewArea = document.createElement('div');
    body.append(fetchBtn, previewArea);

    fetchBtn.addEventListener('click', async () => {
      previewArea.innerHTML = '';
      const raw = repoInput.value.trim();
      const [owner, repo] = raw.split('/').map((s) => s.trim());
      if (!owner || !repo) {
        previewArea.appendChild(statusLine('Enter as owner/repo.', true));
        return;
      }
      const path = pathInput.value.trim() || DEFAULT_MANIFEST_PATH;
      previewArea.appendChild(statusLine('Fetching…'));
      try {
        const resolvedRef = refInput.value.trim() || (await resolveDefaultRef(owner, repo));
        const manifest = await fetchManifest(owner, repo, resolvedRef, path);
        previewArea.innerHTML = '';
        const preview = document.createElement('div');
        preview.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:4px;';
        const title = document.createElement('div');
        title.textContent = `${manifest.displayName || manifest.name} — v${manifest.version || '?'}`;
        title.style.cssText = 'font-weight:600;font-size:13px;';
        const desc = document.createElement('div');
        desc.textContent = manifest.description || '';
        desc.style.cssText = 'font-size:12px;color:var(--text-muted);margin:4px 0 8px;';
        const installBtn = button('Install', { primary: true });
        installBtn.addEventListener('click', async () => {
          try {
            const source = { owner, repo, ref: resolvedRef, path, name: manifest.name, displayName: manifest.displayName || manifest.name, version: manifest.version || null, swatchColor: manifest.swatchColor || '#8b93a3' };
            installModule(nodigraph, manifest, source);
            onInstalled?.();
            closeImport();
            close();
          } catch (err) {
            preview.appendChild(statusLine(`Install failed: ${err.message}`, true));
          }
        });
        preview.append(title, desc, installBtn);
        previewArea.appendChild(preview);
      } catch (err) {
        previewArea.innerHTML = '';
        const needsToken = (err.status === 401 || err.status === 404) && !tokenInput.value.trim();
        previewArea.appendChild(statusLine(`Fetch failed: ${err.message}${needsToken ? ' — this repo may be private; add a token above.' : ''}`, true));
      }
    });

    panel.append(closeBtn, body);
    backdrop.appendChild(panel);
    importHost.appendChild(backdrop);
  }

  function open() {
    host.innerHTML = '';
    host.hidden = false;

    const backdrop = document.createElement('div');
    backdrop.className = 'noditron-dialog-backdrop';
    backdrop.addEventListener('click', close);

    const panel = document.createElement('div');
    panel.className = 'noditron-dialog-panel';
    panel.style.minWidth = '380px';
    panel.addEventListener('click', (e) => e.stopPropagation());

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'noditron-dialog-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', close);

    const body = document.createElement('div');
    body.className = 'noditron-dialog-body';
    body.appendChild(heading('LIBRARY'));

    // Browse — every module tagged noditron-module, loaded up front so
    // opening this dialog is "here's what's out there," not an empty box
    // waiting for a query; the search field just narrows the same list.
    const searchRow = document.createElement('div');
    searchRow.style.cssText = 'display:flex;gap:8px;margin-bottom:4px;';
    const { wrap: searchWrap, input: searchInput } = field('');
    searchInput.placeholder = 'Filter by name…';
    searchWrap.style.flex = '1';
    searchWrap.style.marginBottom = '0';
    const searchBtn = button('Search');
    searchRow.append(searchWrap, searchBtn);
    body.appendChild(searchRow);
    const resultsArea = document.createElement('div');
    body.appendChild(resultsArea);

    function resultRow(result) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);';
      const text = document.createElement('div');
      text.style.cssText = 'min-width:0;';
      const name = document.createElement('div');
      name.textContent = `${result.owner}/${result.repo}`;
      name.style.cssText = 'font-size:12px;font-weight:600;';
      const desc = document.createElement('div');
      desc.textContent = result.description;
      desc.style.cssText = 'font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      text.append(name, desc);
      const installBtn = button('Install', { primary: true });
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.textContent = 'Installing…';
        try {
          const resolvedRef = await resolveDefaultRef(result.owner, result.repo);
          const manifest = await fetchManifest(result.owner, result.repo, resolvedRef);
          const source = { owner: result.owner, repo: result.repo, ref: resolvedRef, path: DEFAULT_MANIFEST_PATH, name: manifest.name, displayName: manifest.displayName || manifest.name, version: manifest.version || null, swatchColor: manifest.swatchColor || '#8b93a3' };
          installModule(nodigraph, manifest, source);
          onInstalled?.();
          close();
        } catch (err) {
          installBtn.disabled = false;
          installBtn.textContent = 'Install';
          row.appendChild(statusLine(`Failed: ${err.message}`, true));
        }
      });
      row.append(text, installBtn);
      return row;
    }

    async function runSearch(query) {
      resultsArea.innerHTML = '';
      resultsArea.appendChild(statusLine('Loading…'));
      try {
        const results = await searchModules(query);
        resultsArea.innerHTML = '';
        if (!results.length) {
          resultsArea.appendChild(
            statusLine(query ? 'No modules match that filter.' : 'No modules published yet — see "Export selected as a module" below, or import one you already know by repo.'),
          );
          return;
        }
        for (const result of results) resultsArea.appendChild(resultRow(result));
      } catch (err) {
        resultsArea.innerHTML = '';
        resultsArea.appendChild(statusLine(`Couldn't load modules: ${err.message}`, true));
      }
    }

    searchBtn.addEventListener('click', () => runSearch(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearch(searchInput.value);
    });
    runSearch('');

    const importLink = button('Import from a repo / manage GitHub token…');
    importLink.style.cssText += 'width:100%;margin-top:10px;text-align:center;justify-content:center;';
    importLink.addEventListener('click', () => openImport());
    body.appendChild(importLink);

    // Export — the authoring side of the loop: build a block by hand (its
    // custom fn/render/html/dialog code included — see logicTab.js), select
    // it, and turn it into a manifest ready to push to a public repo. No
    // separate format to learn: the payload is exactly what nodigraph's own
    // Ctrl+C would put on the clipboard for the same selection.
    body.appendChild(sectionLabel('EXPORT SELECTED AS A MODULE'));
    const selectedCount = nodigraph.selection.count;
    if (!selectedCount) {
      body.appendChild(statusLine('Select one or more blocks on canvas first.'));
    } else {
      const primary = nodigraph.project.getBlock(nodigraph.selection.selectedBlockId);
      const { wrap: nameWrap, input: nameInput } = field('MODULE NAME (used in the file path, lowercase-hyphenated)', { value: slugify(primary?.name) });
      const { wrap: displayWrap, input: displayInput } = field('DISPLAY NAME', { value: primary?.name || 'My Module' });
      const { wrap: descWrap, input: descInput } = field('DESCRIPTION');
      const { wrap: versionWrap, input: versionInput } = field('VERSION', { value: '0.1.0' });
      body.append(nameWrap, displayWrap, descWrap, versionWrap);

      const exportBtn = button(`Download noditron.module.json (${selectedCount} block${selectedCount === 1 ? '' : 's'})`, { primary: true });
      exportBtn.addEventListener('click', () => {
        const payload = serializeSelection(nodigraph.project, nodigraph.selection.list());
        const manifestOut = {
          noditronModule: 1,
          name: slugify(nameInput.value),
          displayName: displayInput.value.trim() || slugify(nameInput.value),
          version: versionInput.value.trim() || '0.1.0',
          description: descInput.value.trim(),
          swatchColor: primary?.style?.color || '#8b93a3',
          block: payload,
        };
        downloadJson('noditron.module.json', manifestOut);
      });
      body.appendChild(exportBtn);

      const exportHint = statusLine('Push the downloaded file to a GitHub repo as noditron.module.json. A public repo tagged with the topic "noditron-module" shows up in search for anyone; a private one installs too, for anyone with a token that can read it.');
      body.appendChild(exportHint);
    }

    // Installed — modules already added to this project, one click to add
    // another instance without searching again.
    const installed = getInstalledModules(nodigraph);
    if (installed.length) {
      body.appendChild(sectionLabel('INSTALLED IN THIS PROJECT'));
      for (const mod of installed) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);';
        const name = document.createElement('div');
        name.textContent = `${mod.displayName} (${mod.owner}/${mod.repo})`;
        name.style.cssText = 'font-size:12px;';
        const addBtn = button('Add another');
        addBtn.addEventListener('click', async () => {
          try {
            const manifest = await fetchManifest(mod.owner, mod.repo, mod.ref, mod.path);
            installModule(nodigraph, manifest, mod);
            onInstalled?.();
            close();
          } catch (err) {
            row.appendChild(statusLine(`Failed: ${err.message}`, true));
          }
        });
        row.append(name, addBtn);
        body.appendChild(row);
      }
    }

    panel.append(closeBtn, body);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);
  }

  return { open, close };
}

export function mountLibrary(nodigraph, container) {
  const divider = document.createElement('div');
  divider.style.cssText = 'height:1px;background:var(--border);margin:6px 2px;';
  container.appendChild(divider);

  const ui = installLibraryUI(nodigraph, () => refreshInstalledButtons());

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  const swatch = document.createElement('span');
  swatch.className = 'noditron-swatch';
  swatch.style.background = '#8b93a3';
  const label = document.createElement('span');
  label.textContent = 'Add from library…';
  openBtn.append(swatch, label);
  openBtn.addEventListener('click', () => ui.open());
  container.appendChild(openBtn);

  const installedGroup = document.createElement('div');
  installedGroup.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  container.appendChild(installedGroup);

  function refreshInstalledButtons() {
    installedGroup.innerHTML = '';
    for (const mod of getInstalledModules(nodigraph)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const sw = document.createElement('span');
      sw.className = 'noditron-swatch';
      sw.style.background = mod.swatchColor || '#8b93a3';
      const lbl = document.createElement('span');
      lbl.textContent = mod.displayName;
      btn.append(sw, lbl);
      btn.addEventListener('click', async () => {
        try {
          const manifest = await fetchManifest(mod.owner, mod.repo, mod.ref, mod.path);
          installModule(nodigraph, manifest, mod);
        } catch (err) {
          // eslint-disable-next-line no-alert
          alert(`Couldn't add ${mod.displayName}: ${err.message}`);
        }
      });
      installedGroup.appendChild(btn);
    }
  }

  refreshInstalledButtons();
}
