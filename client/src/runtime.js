// The "intelligent block" runtime — everything nodigraph itself has no
// idea exists. It never touches nodigraph's source; it only reads the
// live `project` nodigraph's own main.js exposes on window.nodigraph (see
// that file's own comment on the hook) the same way any ordinary nodigraph
// user action would: block.props, block.ports, project.listConnections().
//
// A block becomes "intelligent" purely by having an `fn` prop — a plain
// JS function body, `(inputs, props, helpers) => outputs`, editable per
// block in the Inspector's own "Logic" tab (see logicTab.js/palette.js).
// nodigraph's Inspector just shows `fn` (and `render`/`html`/`dialog`, its
// on-canvas/settings counterparts — see canvasIndicators.js/htmlOverlay.js/
// dialogSystem.js) like any other prop; only this file reads meaning into
// them. `noditronKind` is a second, narrower prop the palette also sets,
// kept only for the one thing that's genuinely special-cased outside this
// generic mechanism: a Bool block's own interactive click-to-toggle (see
// canvasIndicators.js) — everything else here treats every block the same.
//
// `helpers.fetchJson(url)` (see apiFetch.js) is what makes an otherwise
// purely synchronous `fn` able to pull in an API response — it returns
// `undefined` until the request resolves, so a block reading it just
// naturally sees its own output go from undefined to real data across a
// couple of ~100ms ticks, the same fixed-point-relaxation loop below
// already re-runs every block through anyway.
import { fetchJson, fetchStatus } from './apiFetch.js';

export const KIND_PROP = 'noditronKind';

// `helpers.changed(key, value)` (see palette.js's Bool/Data blocks) — true
// for exactly the one *tick* (one evaluateLevel() call) where `value`
// first differs from whatever it was committed as at the end of the
// *previous* tick, false every other tick (including the very first, so a
// block doesn't fire the instant it's created — there's nothing to have
// changed *from* yet). `key` just lets one block track more than one
// independent thing (e.g. its own value vs its own wiring) without them
// clobbering each other.
//
// `changeTracker` is the committed, cross-tick record — a plain
// module-level Map, same lifetime as apiFetch.js's own cache. It is
// deliberately *not* written to directly by `changed()` itself: the
// fixed-point relaxation loop below calls runOnce() — and so a block's own
// `changed()` — several times within a single tick, all still comparing
// against the same still-uncommitted answer, or the second pass would see
// the first pass's own update and immediately think nothing changed,
// erasing the pulse before evaluateLevel even returns it. Each tick's
// updates land in evaluateLevel's own local `pending` Map instead, and
// only get folded into `changeTracker` once, after that tick's relaxation
// loop has fully settled (see the commit step near the bottom of
// evaluateLevel) — so every pass this tick agrees, and the *next* tick is
// what finally compares against it.
const changeTracker = new Map(); // `${blockId}:${key}` -> last committed JSON.stringify'd value
function changed(pending, blockId, key, value) {
  const trackKey = `${blockId}:${key}`;
  const serialized = JSON.stringify(value);
  pending.set(trackKey, serialized);
  const committed = changeTracker.get(trackKey);
  return committed !== undefined && committed !== serialized;
}

// A stable fingerprint of every connection currently touching any of this
// block's own ports — changes exactly when a wire is added, removed, or
// swapped for a different one, regardless of what value is flowing over
// it. Combined with `changed()` above, this is what lets a primitive
// notice "somebody just rewired me," not only "my value just changed."
function wiringSignature(block, connections) {
  const portIds = new Set((block.ports || []).map((p) => p.id));
  return connections
    .filter((c) => portIds.has(c.sourcePortId) || portIds.has(c.targetPortId))
    .map((c) => c.id)
    .sort()
    .join(',');
}

export function kindOf(block) {
  return (block.props || []).find((p) => p.name === KIND_PROP)?.value || null;
}

function propsObject(block) {
  const obj = {};
  for (const p of block.props || []) obj[p.name] = p.value;
  return obj;
}

function logicalName(block, pin) {
  return (block.logicalPorts || []).find((lp) => lp.id === pin.logicalId)?.name;
}

// Every named, directioned port on a block, split by direction — a port
// with no name or no committed direction can't be addressed by a function
// (there'd be no key to read/write on inputs/outputs), so it's skipped.
function portsBySide(block) {
  const ins = [];
  const outs = [];
  for (const pin of block.ports || []) {
    const name = logicalName(block, pin);
    if (!name) continue;
    const direction = (block.logicalPorts || []).find((lp) => lp.id === pin.logicalId)?.direction;
    if (direction === 'in') ins.push({ name, pin });
    else if (direction === 'out') outs.push({ name, pin });
  }
  return { ins, outs };
}

// Compiled once per block per source string, not once per tick (every
// 100ms — see startRuntime) — re-parsing an unchanged function body ten
// times a second would be pure waste.
const compiledCache = new Map(); // blockId -> { source, fn }
function compiledFn(blockId, source) {
  const cached = compiledCache.get(blockId);
  if (cached && cached.source === source) return cached.fn;
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('inputs', 'props', 'helpers', source);
  } catch (err) {
    fn = () => {
      throw err;
    };
  }
  compiledCache.set(blockId, { source, fn });
  return fn;
}

// Evaluates every block with an `fn` prop at whatever level `project` is
// currently viewing — deliberately just the blocks visible right now, not
// a recursive walk of the whole tree, so wiring a bool to an AND-gate a
// level deep works exactly like it does at the top.
export function evaluateLevel(project) {
  const blocks = project.listBlocks();
  const connections = project.listConnections();

  const outputValue = new Map(); // `${blockId}:${pinId}` -> value
  const inputsByBlock = new Map();
  const outputsByBlock = new Map();
  const errors = new Map();
  const pendingChanges = new Map(); // this tick's own helpers.changed() calls — see changed()'s own doc

  function inputsFor(block) {
    const { ins } = portsBySide(block);
    const obj = {};
    for (const { name, pin } of ins) {
      const wire = connections.find((c) => c.targetBlockId === block.id && c.targetPortId === pin.id);
      obj[name] = wire ? outputValue.get(`${wire.sourceBlockId}:${wire.sourcePortId}`) : undefined;
    }
    return obj;
  }

  // A container block's own child, read by name (e.g. Timer reading its
  // T_ON/T_OFF Data children — see palette.js): that child's own constant
  // `value` prop by default, or whatever's wired in from *outside* the
  // container if the child's own port has been dragged out to the
  // container's boundary (nodigraph's own generic feature) and something
  // out there is wired into it. That's a genuine two-hop chain, and the
  // two hops live in two different connection lists:
  //   1. child's own port -> the container's own port, wired from
  //      *inside* the container (while looking at Timer's own
  //      child-graph) — recorded in `block.children.connections`.
  //   2. the container's own port -> whatever external block feeds it,
  //      wired from *outside* the container (while looking at whatever
  //      level Timer itself lives on) — recorded in `connections`, the
  //      same list every ordinary wire at *this* level already resolves
  //      through.
  // A boundary port is really nothing more than one of the container's
  // own ports rendered a second time, on the inside — so both hops are
  // just ordinary connections; nothing here is magic, it's just two plain
  // lookups chained instead of one.
  //
  // Deliberately shallow past that: reads the *external* source's already-
  // computed output rather than recursively evaluating it, and reads the
  // child's own constant `value` prop rather than running its own `fn` —
  // fine for a plain value-holder like Data, not a general nested-
  // evaluation engine (out of scope here).
  function childValue(block, childName) {
    const child = block.children ? [...block.children.blocks.values()].find((b) => b.name === childName) : null;
    if (!child) return undefined;
    const childPort = child.ports?.[0];
    if (childPort && block.children) {
      const innerConnections = [...block.children.connections.values()];
      const innerWire = innerConnections.find(
        (c) =>
          (c.sourceBlockId === child.id && c.sourcePortId === childPort.id) ||
          (c.targetBlockId === child.id && c.targetPortId === childPort.id),
      );
      const containerPortId =
        innerWire?.sourceBlockId === block.id
          ? innerWire.sourcePortId
          : innerWire?.targetBlockId === block.id
            ? innerWire.targetPortId
            : null;
      if (containerPortId) {
        const outerWire = connections.find((c) => c.targetBlockId === block.id && c.targetPortId === containerPortId);
        if (outerWire) return outputValue.get(`${outerWire.sourceBlockId}:${outerWire.sourcePortId}`);
      }
    }
    return child.props?.find((p) => p.name === 'value')?.value;
  }

  function runOnce(block) {
    const fnSource = block.props?.find((p) => p.name === 'fn')?.value;
    if (!fnSource) return;
    const inputs = inputsFor(block);
    const props = propsObject(block);
    const helpers = {
      fetchJson,
      fetchStatus,
      childValue: (name) => childValue(block, name),
      changed: (key, value) => changed(pendingChanges, block.id, key, value),
      portsSignature: () => wiringSignature(block, connections),
    };
    let outputs = {};
    try {
      const result = compiledFn(block.id, String(fnSource))(inputs, props, helpers);
      outputs = result && typeof result === 'object' ? result : {};
      errors.delete(block.id);
    } catch (err) {
      errors.set(block.id, err.message);
    }
    inputsByBlock.set(block.id, inputs);
    outputsByBlock.set(block.id, outputs);
    const { outs } = portsBySide(block);
    for (const { name, pin } of outs) outputValue.set(`${block.id}:${pin.id}`, outputs[name]);
  }

  // A fixed-point relaxation, not a real topological sort: cheap, and
  // settles any wire chain up to `blocks.length` connections deep, which
  // covers every diagram this runtime is meant for (revisit if a genuinely
  // deep chain of custom blocks ever needs more).
  for (let pass = 0; pass <= blocks.length; pass += 1) {
    for (const block of blocks) runOnce(block);
  }

  // Commit this tick's helpers.changed() values now that every pass has
  // settled — see changed()'s own doc on why this can't just happen inline
  // inside changed() itself.
  for (const [key, value] of pendingChanges) changeTracker.set(key, value);

  return { blocks, inputsByBlock, outputsByBlock, errors };
}

// The "global timer" — re-evaluates on a plain interval rather than
// wiring into nodigraph's own change events, so this stays a pure reader
// of public state and never needs to know when nodigraph considers
// something "changed". `onTick` gets the fresh evaluation every interval;
// the same result is also kept for logicTab.js's own "Test" button, which
// wants the latest values without running its own separate evaluation.
let lastResult = { blocks: [], inputsByBlock: new Map(), outputsByBlock: new Map(), errors: new Map() };
export function getLastResult() {
  return lastResult;
}

export function startRuntime(nodigraph, onTick, intervalMs = 100) {
  const timer = setInterval(() => {
    lastResult = evaluateLevel(nodigraph.project);
    onTick(lastResult);
  }, intervalMs);
  return () => clearInterval(timer);
}
