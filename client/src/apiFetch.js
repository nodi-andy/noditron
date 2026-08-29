// A small fetch-with-cache used by `fn`'s own `helpers.fetchJson(url)` (see
// runtime.js) — `fn` is otherwise purely synchronous (called ~10x/second,
// see evaluateLevel's fixed-point relaxation), so it can't itself `await` a
// network response. This gives it something that *looks* synchronous
// instead: the first call for a given URL kicks off the real fetch and
// returns `undefined`; every call after that returns whatever's cached —
// `undefined` while still in flight, the parsed JSON once it resolves.
// Nothing here re-fetches on its own — a block wanting fresh data just
// needs a different URL (see palette.js's Weather block, which changes URL
// whenever its location prop changes).
const cache = new Map(); // url -> { status: 'loading'|'ready'|'error', data, error }

export function fetchJson(url) {
  if (!url) return undefined;
  let entry = cache.get(url);
  if (!entry) {
    entry = { status: 'loading', data: undefined, error: undefined };
    cache.set(url, entry);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        entry.status = 'ready';
        entry.data = data;
      })
      .catch((err) => {
        entry.status = 'error';
        entry.error = err.message;
      });
  }
  return entry.status === 'ready' ? entry.data : undefined;
}

export function fetchStatus(url) {
  if (!url) return 'idle';
  return cache.get(url)?.status || 'idle';
}
