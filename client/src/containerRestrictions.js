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
export function getAllowedChildKinds(nodigraph) {
  const container = nodigraph.project.getContainerBlock();
  const prop = (container?.props || []).find((p) => p.name === 'allowedChildKinds');
  if (!prop || !prop.value) return null;
  try {
    const parsed = JSON.parse(prop.value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
