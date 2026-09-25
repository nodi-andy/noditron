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

// A container's own boundary port, fed from *inside* it by an ordinary
// wire (AND.out -> the container's own port, say) — computed once per tick
// by evaluateSubtree()'s whole-tree walk below, independent of whatever
// level is actually being *viewed* right now. Read by inputsFor()'s own
// fallback below when a wire's source lives on a different level than the
// block receiving it: this is what lets a value computed three levels deep
// reach something wired to it two levels up, without that outer level
// needing to be the one currently on screen. Keyed by (containerId,
// portId) rather than just containerId, since a container can expose more
// than one boundary port.
const boundaryOutputCache = new Map(); // containerId -> Map(portId -> value)

// Values a container's own pins carry OUT to the level above that come
// from outside the diagram instead of from a wire inside — what an ESP32
// DevKit's circuit actually sent the browser over USB (see main.js's
// syncLiveDigitalIO). Laid over the computed values each time the
// container's level is evaluated; set and cleared by the host.
const boundaryOutputOverrides = new Map(); // containerId -> Map(portId -> value)
export function setBoundaryOutput(containerId, portId, value) {
  let map = boundaryOutputOverrides.get(containerId);
  if (!map) {
    map = new Map();
    boundaryOutputOverrides.set(containerId, map);
  }
  map.set(portId, value);
}
export function clearBoundaryOutput(containerId, portId) {
  boundaryOutputOverrides.get(containerId)?.delete(portId);
}
export function getBoundaryOutput(containerId, portId) {
  return boundaryOutputCache.get(containerId)?.get(portId);
}

// What every port on every level is carrying this tick, keyed exactly the
// way a level's own `outputValue` is (`${blockId}:${portId}`).
//
// The whole-tree counterpart to getLastResult(), which only ever holds the
// one level currently being edited (see startRuntime). That is fine for
// anything asking about the level it is standing in, and useless for
// anything asking about a level it is merely *looking at*: a container
// drawn open on the canvas shows its children and their wires (see
// nodigraph's SubPreviewRenderer) while the current level is still the one
// outside it, so every wire in there had no value to find and read as
// carrying nothing at all — the live colours only appeared once you had
// zoomed in far enough for that level to actually become the current one.
//
// Rebuilt from scratch each tick rather than accumulated, so a block that
// has been deleted takes its entries with it instead of leaving a value
// that will never be updated again.
const portValues = new Map();
export function getPortValue(blockId, portId) {
  return portValues.get(`${blockId}:${portId}`);
}

// A block's outputs by port name from the whole-tree values, for a block
// that is not on the level being edited and so has no entry in
// getLastResult() — a child shown open inside its container, say.
export function getBlockOutputs(block) {
  const outputs = {};
  for (const pin of block.ports || []) {
    const value = portValues.get(`${block.id}:${pin.id}`);
    if (value === undefined) continue;
    const name = logicalName(block, pin);
    if (name) outputs[name] = value;
  }
  return outputs;
}

// Values a host knows for a container's children when it is NOT running
// them itself — a board whose firmware owns the circuit, reporting what
// its pins and its USB link actually carry (see main.js's
// syncLiveDigitalIO). Read in evaluateSubtree's not-evaluated branch, so
// wires and indicators inside such a container show the board's values
// rather than nothing. Cleared and refilled by the host every tick.
const childOutputOverrides = new Map(); // containerId -> Map(`${blockId}:${portId}` -> { blockId, portId, value })
export function setChildOutput(containerId, blockId, portId, value) {
  let map = childOutputOverrides.get(containerId);
  if (!map) {
    map = new Map();
    childOutputOverrides.set(containerId, map);
  }
  map.set(`${blockId}:${portId}`, { blockId, portId, value });
}
export function clearChildOutputs(containerId) {
  childOutputOverrides.delete(containerId);
}

// The mirror image of boundaryOutputCache above, for the direction that
// used to have no path through this file at all: a container's own
// boundary *input* — fed from *outside* it — reaching an internal child
// that's wired to `self.<port>` from the inside. runOnce below fills this
// in for every hasChildren block, container or not, using whatever's
// currently wired into its own input ports one level up; evaluateSubtree
// reads it back to seed a container's own children level before their
// relaxation runs.
//
// Necessarily one tick behind, not same-tick: a container's own inputs
// are only known once its *parent* level's own relaxation has run
// runOnce() on it, but evaluateSubtree's whole-tree walk processes a
// container's children *before* that parent level (post-order, so a
// container's own boundary *outputs* — computed from its already-settled
// children — are ready by the time anything outside reads them same-tick,
// see boundaryOutputCache above). Feeding a child the value its own
// container carried one level up on the very same tick would need that
// parent level evaluated first, which would then need *its* own parent's
// same-tick value in turn, all the way up — asking for a same-tick answer
// to a question that has no fixed order to settle in for a tree walked
// this way. One tick of latency here (~100ms) sidesteps that entirely: by
// the time a container's children level runs, boundaryInputCache already
// holds whatever its own inputs were as of last tick's parent-level
// relaxation, so there's nothing left to resolve out of order. One
// runtime interval (~100ms) of lag on a signal crossing into a container
// is not something anyone clicking a button or watching a wire will ever
// notice.
const boundaryInputCache = new Map(); // containerId -> Map(pinId -> value)

// Sets what one of a container's own pins carries into its level, for a
// pin fed from outside the diagram rather than by a wire one level up —
// an ESP32 DevKit's GPIO read live off the board (see main.js's
// syncLiveDigitalIO). Meant for evaluateLevel's `beforeLevel` hook, which
// runs right before the level reads these: the parent level's own pass
// rewrites the container's entries from its outer wires every tick, so a
// value set here holds for exactly the tick it was set in.
export function setBoundaryInput(containerId, pinId, value) {
  let map = boundaryInputCache.get(containerId);
  if (!map) {
    map = new Map();
    boundaryInputCache.set(containerId, map);
  }
  map.set(pinId, value);
}

function computeBoundaryOutputs(container, innerConnections, outputValueMap) {
  const out = new Map();
  for (const conn of innerConnections) {
    if (conn.targetBlockId !== container.id) continue;
    const val = outputValueMap.get(`${conn.sourceBlockId}:${conn.sourcePortId}`);
    if (val !== undefined) out.set(conn.targetPortId, val);
  }
  return out;
}

// The actual per-level evaluator — factored out so evaluateSubtree()'s own
// whole-tree walk (see below) can run it once per level directly against
// that level's own blocks/connections, without needing a live
// nodigraph.project pointed at that specific level: project.path is a
// single, current-view-only pointer, and a level three containers away
// from whatever's on screen right now has no path that would resolve to
// it without disturbing the user's own navigation.
// `outputValue` is normally seeded fresh per call (evaluateLevel's own
// one-shot use, e.g. logicTab.js's "Test" button) -- but evaluateSubtree
// below passes in the SAME Map every tick for a given container, kept
// alive across calls, specifically so a cyclic wire loop keeps whatever
// value it last settled on instead of being re-derived from a blank slate
// every 100ms. That persistence is the only thing that makes a feedback
// loop able to hold state at all (a cross-coupled Gate+NOT latch, say):
// with a fresh Map every tick, pass 0 sees every looped wire as undefined
// again, so the relaxation has no memory of which state it was just in and
// can land on a different, sometimes wrong, answer purely from the current
// tick's pass order -- confirmed by hand-simulating this exact algorithm
// against a real cross-coupled latch: identical wiring holds correctly
// with a persisted Map and does not with a fresh one.
function evaluateBlocksAndConnections(blocks, connections, outputValue = new Map()) {
  // `${blockId}:${pinId}` -> value
  const inputsByBlock = new Map();
  const outputsByBlock = new Map();
  const errors = new Map();
  const pendingChanges = new Map(); // this tick's own helpers.changed() calls — see changed()'s own doc
  const pendingPersist = new Map(); // `${blockId}:${propName}` -> value, see runOnce's own __persist doc

  function inputsFor(block) {
    const { ins } = portsBySide(block);
    const obj = {};
    for (const { name, pin } of ins) {
      const wire = connections.find((c) => c.targetBlockId === block.id && c.targetPortId === pin.id);
      if (!wire) { obj[name] = undefined; continue; }
      const direct = outputValue.get(`${wire.sourceBlockId}:${wire.sourcePortId}`);
      // A wire whose source isn't one of this level's own blocks — it
      // crosses in from further out, through a container's boundary port
      // one or more levels away — never gets a same-pass value here (this
      // level's own outputValue only ever holds blocks actually run this
      // pass). getBoundaryOutput reads whatever that outer container's own
      // subtree already computed for it this same tick (see evaluateSubtree
      // below) instead. This is a different, more general mechanism than
      // childValue()'s own inbound two-hop lookup just below — that one's
      // scoped to a container reading one specific *named child* by value;
      // this is the generic "any wire, any depth" case any ordinary `in`
      // port already goes through.
      obj[name] = direct !== undefined ? direct : getBoundaryOutput(wire.sourceBlockId, wire.sourcePortId);
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

  // A container's own CURRENT input values, regardless of whether it has
  // an `fn` of its own — see evaluateSubtree's own doc on
  // boundaryInputCache for what consumes this and why. `overrides`, when
  // given, is that same container's own just-computed `outputs` — an `fn`
  // is free to return a key matching one of its own *input* port names
  // (not just its output ports, which is all the ordinary outputValue
  // write below ever looks at) to reshape what its children actually see
  // for that one port, e.g. turning a plain held level into a proper one-
  // tick pulse the same way ownOutput()+changed() already does for an
  // output (see palette.js's own createStateBlock, `transIn`) — any input
  // name `fn` doesn't mention just falls back to the raw wire value, same
  // as a block with no `fn` at all gets for every one of its inputs.
  function captureBoundaryInputs(block, inputs, overrides) {
    const { ins } = portsBySide(block);
    const map = new Map();
    for (const { name, pin } of ins) {
      const val = overrides && overrides[name] !== undefined ? overrides[name] : inputs[name];
      map.set(pin.id, val);
    }
    boundaryInputCache.set(block.id, map);
  }

  function runOnce(block) {
    const inputs = inputsFor(block);
    const fnSource = block.props?.find((p) => p.name === 'fn')?.value;
    if (!fnSource) {
      if (block.hasChildren) captureBoundaryInputs(block, inputs, null);
      inputsByBlock.set(block.id, inputs);
      return;
    }
    const props = propsObject(block);
    const helpers = {
      fetchJson,
      fetchStatus,
      childValue: (name) => childValue(block, name),
      changed: (key, value) => changed(pendingChanges, block.id, key, value),
      portsSignature: () => wiringSignature(block, connections),
      // This block's own output port names, in the order its pins sit on
      // it. A block that fans a value out to "whichever output matched"
      // (see palette.js's Match and Route) has to name the key it returns,
      // and hard-coding out1/out2/... means the moment someone renames a
      // port in the Inspector the block quietly stops emitting anything:
      // the returned key no longer matches any port. Reading the real
      // names instead makes renaming free, and adding an output work with
      // nothing in the block's own code to change.
      outputNames: () => portsBySide(block).outs.map((o) => o.name),
      // Whether a named port actually has a wire on it — as opposed to
      // being wired to something that happens to be sending nothing right
      // now, which `inputs[name] === undefined` cannot tell apart. A block
      // that behaves differently when a port is connected at all (Data:
      // trigger-driven when something is wired to `in`, a plain constant
      // when nothing is) needs the distinction to be about the wiring,
      // not about whether a value happens to be in flight this tick.
      isWired: (name) => {
        const { ins, outs } = portsBySide(block);
        const pin = [...ins, ...outs].find((p) => p.name === name)?.pin;
        if (!pin) return false;
        return connections.some(
          (c) =>
            (c.targetBlockId === block.id && c.targetPortId === pin.id) ||
            (c.sourceBlockId === block.id && c.sourcePortId === pin.id),
        );
      },
      // This container's OWN boundary output, already fresh for this same
      // tick (see evaluateSubtree's post-order walk — a container's
      // children, and so its own boundaryOutputCache entry, are always
      // settled before its own fn ever runs). Exists for the rare case a
      // container's `fn` needs to react to what its *own* internal wiring
      // just produced — a momentary pulse born and consumed within the
      // same tick's relaxation (see palette.js's own createStateBlock,
      // `transOut`) has no other way to survive being read from outside:
      // by the time a same-tick feedback loop settles to its final,
      // recorded value, the pulse that caused the settling is already
      // gone, the same reason __persist above has to defer its own commit.
      // Watching that settled boundary value's own edge here, and turning
      // it back into a proper one-tick pulse via changed()+__persist,
      // sidesteps that without needing the loop itself to change at all.
      ownOutput: (name) => {
        const { outs } = portsBySide(block);
        const p = outs.find((o) => o.name === name);
        return p ? getBoundaryOutput(block.id, p.pin.id) : undefined;
      },
    };
    let outputs = {};
    try {
      const result = compiledFn(block.id, String(fnSource))(inputs, props, helpers);
      outputs = result && typeof result === 'object' ? result : {};
      errors.delete(block.id);
    } catch (err) {
      errors.set(block.id, err.message);
    }
    if (block.hasChildren) captureBoundaryInputs(block, inputs, outputs);

    // The one way an `fn` can hold a value across ticks instead of only
    // reacting to whatever's on its wires *this* instant — everything
    // else about `fn` (inputs/props/outputs) is recomputed from scratch
    // every single call, same as before. Recorded here, not written onto
    // `block.props` yet — see the commit step below (same two-step shape
    // as `changed()`'s own pendingChanges, and for the identical reason:
    // a block whose *own* newly-written prop flips what it would compute
    // next pass — e.g. a momentary pulse output computed alongside "turn
    // my own latch off" — would only get to pulse true on pass 1, then
    // silently correct itself back to false by the final pass once its
    // own prop write took hold, erasing the very pulse this tick was
    // supposed to record). Committing once, only after every pass this
    // tick has already run against the SAME still-unwritten prop value,
    // is what keeps that pulse showing up in this tick's actual recorded
    // output — see palette.js's own createStateBlock for the block this
    // was built for.
    if (outputs.__persist && typeof outputs.__persist === 'object') {
      for (const [propName, value] of Object.entries(outputs.__persist)) {
        if (!block.props?.find((p) => p.name === propName)) continue; // never fabricates a new prop
        pendingPersist.set(`${block.id}:${propName}`, value);
      }
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

  // Same deferred-commit reasoning as changed() above, for __persist — see
  // runOnce's own doc on why writing straight onto block.props mid-pass
  // would erase a same-tick pulse before it ever got recorded.
  for (const [key, value] of pendingPersist) {
    const [blockId, propName] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const block = blocks.find((b) => b.id === blockId);
    const prop = block?.props?.find((p) => p.name === propName);
    if (prop) prop.value = value;
  }

  return { blocks, inputsByBlock, outputsByBlock, errors, outputValue };
}

// Public single-level entry point — unchanged shape from before
// boundaryOutputCache existed; nothing outside startRuntime's own tick
// calls this today, but kept as the obvious "just evaluate this one level"
// API rather than making every caller reach into evaluateSubtree's own
// whole-tree machinery for a single answer.
export function evaluateLevel(project) {
  return evaluateBlocksAndConnections(project.listBlocks(), project.listConnections());
}

// Walks the *whole* block tree every tick, not just whatever's on screen —
// post-order (every level's own children fully evaluated, including their
// own further-nested children, before that level itself runs), so a
// container's boundaryOutputCache entry is always populated before
// anything shallower tries to read it this same tick, all the way out
// to the root. `results.current` ends up holding whichever level's own
// result matches `currentLevelBlock` (===, real object identity — every
// block reference here comes straight from the live project tree, never a
// copy), for startRuntime's own return value below.
//
// `beforeLevel(container, blocks)`, if given, runs right before this
// level's own blocks get evaluated — a host's one chance to mutate a
// block's own props (a live sensor reading, say) so THIS tick's `fn` runs
// actually see it, not next tick. This file has no idea what that means
// for any specific block (see this file's own top-of-file doc: it "never
// touches nodigraph's source" and knows nothing domain-specific) — main.js
// is what supplies one, to keep a Bool block's own props.value in sync
// with a connected board's live GPIO state regardless of which level is
// currently on screen (a per-block html script, like DIGITAL_IO_HTML used
// to do this in, only ever runs while its own container is actually being
// *drawn* — exactly the level-gating this whole-tree walk exists to get
// away from).
// One persisted outputValue Map per container, reused tick after tick —
// see evaluateBlocksAndConnections's own doc on why this specific
// cross-tick survival is what lets a cyclic wire loop hold state at all.
// Keyed by container id, same lifetime/leak profile as boundaryOutputCache
// just above (a deleted container's entry just sits unused, no different
// from changeTracker/compiledCache elsewhere in this file).
const levelOutputValueCache = new Map(); // containerId -> outputValue Map
function evaluateSubtree(container, currentLevelBlock, results, beforeLevel) {
  if (!container.children) {
    beforeLevel?.(container, []);
    return;
  }
  const blocks = [...container.children.blocks.values()];
  const evaluateChildren = beforeLevel?.(container, blocks) !== false;
  if (evaluateChildren) {
    for (const block of blocks) evaluateSubtree(block, currentLevelBlock, results, beforeLevel);
  }
  if (!evaluateChildren) {
    const boundaryOut = new Map(boundaryOutputOverrides.get(container.id) || []);
    boundaryOutputCache.set(container.id, boundaryOut);
    // What the host reports for this level stands in for an evaluation:
    // the container's own pins as seen from inside (boundaryInputCache)
    // and whatever child outputs it knows (childOutputOverrides), so a
    // wire from a live input pin or into a live output pin still colours
    // and a child's own indicator still reads the value.
    const outputsByBlock = new Map();
    for (const [pinId, value] of boundaryInputCache.get(container.id) || []) portValues.set(`${container.id}:${pinId}`, value);
    for (const [key, { blockId, portId, value }] of childOutputOverrides.get(container.id) || []) {
      portValues.set(key, value);
      const block = container.children.blocks.get(blockId);
      const pin = block && (block.ports || []).find((p) => p.id === portId);
      const name = pin && logicalName(block, pin);
      if (!name) continue;
      if (!outputsByBlock.has(blockId)) outputsByBlock.set(blockId, {});
      outputsByBlock.get(blockId)[name] = value;
    }
    if (container === currentLevelBlock) results.current = { blocks, inputsByBlock: new Map(), outputsByBlock, errors: new Map() };
    return;
  }

  let outputValue = levelOutputValueCache.get(container.id);
  if (!outputValue) {
    outputValue = new Map();
    levelOutputValueCache.set(container.id, outputValue);
  }
  // See boundaryInputCache's own doc above -- this container's current
  // boundary input values, one tick behind, made available to its own
  // children the same way any ordinary same-level wire already resolves
  // (inputsFor()'s own outputValue.get lookup, no separate code path).
  const boundaryIn = boundaryInputCache.get(container.id);
  if (boundaryIn) {
    for (const [pinId, value] of boundaryIn) outputValue.set(`${container.id}:${pinId}`, value);
  }
  const connections = [...container.children.connections.values()];
  const result = evaluateBlocksAndConnections(blocks, connections, outputValue);
  const boundaryOut = computeBoundaryOutputs(container, connections, result.outputValue);
  for (const [portId, value] of boundaryOutputOverrides.get(container.id) || []) {
    if (value === undefined) boundaryOut.delete(portId);
    else boundaryOut.set(portId, value);
  }
  boundaryOutputCache.set(container.id, boundaryOut);
  // Mirrored out of this level's own (deliberately cross-tick persistent)
  // outputValue so every level's values are reachable by block+port from
  // anywhere — see getPortValue.
  for (const [key, value] of result.outputValue) portValues.set(key, value);
  if (container === currentLevelBlock) results.current = result;
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

export function startRuntime(nodigraph, onTick, intervalMs = 100, beforeLevel) {
  const timer = setInterval(() => {
    const results = {};
    portValues.clear(); // see getPortValue — rebuilt from every level below
    // rootBlock stands in as the top-level "container" — Project.js's own
    // doc: "the whole product is itself a Block" — so evaluating from here
    // covers every level uniformly, root included, with no special case.
    evaluateSubtree(nodigraph.project.rootBlock, nodigraph.project.getContainerBlock(), results, beforeLevel);
    lastResult = results.current || lastResult;
    onTick(lastResult);
  }, intervalMs);
  return () => clearInterval(timer);
}
