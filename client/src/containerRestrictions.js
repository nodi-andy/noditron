// Lets any block opt into restricting what can be added directly inside
// it — an `allowedChildKinds` prop, a JSON array of noditronKind strings
// (see runtime.js's KIND_PROP). No prop, or an unparsable one, means
// unrestricted: every ordinary container stays exactly as open as before.
// Not a nodigraph concept at all — nodigraph's own containers have no
// opinion on what belongs inside them; this is purely a noditron-side
// convention any block's own author can use (built-in palette primitive
// or a library module, ESP32 DevKit included — see its own
// noditron.module.json).
//
// Kind, not name, is what gets matched: kind is the stable identifier set
// once at a block's creation (addKindProp in palette.js, or a library
// module's own noditronKind prop) and never changes even if someone
// renames the block on canvas — a name is just a label, not safe to gate
// behavior on.
//
// Asked of the block a new block would land in (see addTarget), not merely
// the level being edited: with a block selected, nodigraph adds inside it —
// the dotted background marks it — so its restrictions are the ones that
// apply. An older nodigraph without addTarget falls back to the level.
export function addTarget(nodigraph) {
  return nodigraph.addTarget?.() || nodigraph.project.getContainerBlock();
}

// Moves nodigraph's editing focus to addTarget before a block is added,
// exactly as nodigraph's own + button does — so project.addBlock (or a
// paste) lands in the selected block rather than beside it.
export function prepareAdd(nodigraph) {
  nodigraph.prepareAdd?.();
}

export function getAllowedChildKinds(nodigraph) {
  const container = addTarget(nodigraph);
  const prop = (container?.props || []).find((p) => p.name === 'allowedChildKinds');
  if (!prop || !prop.value) return null;
  return parseKindList(prop.value);
}

// A JSON array of kinds — or the same list with its quotes gone, `[a,b]`,
// which is what a round-trip through the slim YAML format has been seen to
// leave behind (modules/esp32-devkit carried exactly that, and silently
// lost its restriction). Anything else still means unrestricted.
function parseKindList(value) {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value).trim();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    const bare = /^\[([^\]]*)\]$/.exec(text);
    if (!bare) return null;
    return bare[1].split(',').map((kind) => kind.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
}
