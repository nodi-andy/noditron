// The Inspector's "Logic" tab (registered via window.nodigraphExtraTabs —
// see registerExtraTabs.js and nodigraph's own InspectorPanel.mountInspector
// doc). Lets a block's four customization props be edited directly:
//   Function — see runtime.js — plain data in/out, ~10x/second.
//   Render   — see canvasIndicators.js — hand-drawn canvas, every frame.
//   HTML     — see htmlOverlay.js — real positioned DOM, every frame.
//   Dialog   — see dialogSystem.js — a settings panel shown on demand.
// "Test now" runs the live runtime once and shows exactly what this block
// computed — the same values the on-canvas indicator/html is drawing from,
// not a separate simulation. "Open dialog" previews the Dialog field the
// same way, without needing to find this block's own gear/button trigger.
import { generateId } from '/nodigraph/src/model/Block.js';
import { serializeBlockDescription } from '/nodigraph/src/model/BlockDescription.js';
import { getLastResult } from './runtime.js';
import { openDialogPreview } from './dialogSystem.js';

const DEFAULT_FN = 'return {};';
const DEFAULT_RENDER = '// helpers.dot(Boolean(outputs.someOutput));';
const DEFAULT_HTML = '// container.textContent = String(outputs.someOutput);';
const DEFAULT_DIALOG = "// container.innerHTML = '<p>Settings go here.</p>';";

function getOrCreateProp(block, name, defaultValue, persist) {
  let prop = block.props.find((p) => p.name === name);
  if (!prop) {
    prop = { id: generateId('prp'), name, kind: 'value', value: defaultValue };
    block.props.push(prop);
    block.description = serializeBlockDescription(block);
    persist();
  }
  return prop;
}

function codeField(container, labelText, signature, prop, block, requestRender, persist) {
  const wrapper = document.createElement('div');
  wrapper.className = 'field noditron-logic-field';

  const label = document.createElement('label');
  label.textContent = labelText;
  wrapper.appendChild(label);

  const sig = document.createElement('code');
  sig.className = 'noditron-logic-sig';
  sig.textContent = signature;
  wrapper.appendChild(sig);

  const textarea = document.createElement('textarea');
  textarea.className = 'noditron-logic-textarea';
  textarea.spellcheck = false;
  textarea.rows = 6;
  textarea.value = String(prop.value ?? '');
  textarea.addEventListener('input', () => {
    prop.value = textarea.value;
    block.description = serializeBlockDescription(block);
    requestRender();
  });
  textarea.addEventListener('change', persist);
  wrapper.appendChild(textarea);

  container.appendChild(wrapper);
  return textarea;
}

export function renderLogicTab(container, { block, requestRender, persist }) {
  container.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'hint-text';
  intro.textContent =
    "Custom behavior for this block — nodigraph itself never reads these, they're plain props like any other. Function runs ~10x/second; its helpers.fetchJson(url) returns undefined until a request resolves, then the parsed response, so a block can pull in an API response without needing to be async itself; its helpers.childValue(name) reads a named child block's own value if this block has a sub-architecture (see Timer); its helpers.changed(key, value) is true for exactly one tick whenever value differs from the last time this same key was checked (see Bool/Data), and helpers.portsSignature() gives it something to feed in for 'my wiring changed' specifically. Render draws straight into nodigraph's own canvas paint, every frame — good for simple indicators. HTML gives you real positioned DOM instead (an actual slider, not a drawn approximation of one) — same every-frame positioning, just a <div> instead of ctx. Dialog builds a settings panel shown on demand, not tied to the block's on-canvas position at all.";
  container.appendChild(intro);

  const fnProp = getOrCreateProp(block, 'fn', DEFAULT_FN, persist);
  const renderProp = getOrCreateProp(block, 'render', DEFAULT_RENDER, persist);
  const htmlProp = getOrCreateProp(block, 'html', DEFAULT_HTML, persist);
  const dialogProp = getOrCreateProp(block, 'dialog', DEFAULT_DIALOG, persist);

  codeField(container, 'Function', 'function(inputs, props, helpers) { ... return outputs; }', fnProp, block, requestRender, persist);
  codeField(container, 'Render', 'function(ctx, block, inputs, outputs, helpers) { ... }', renderProp, block, requestRender, persist);
  codeField(container, 'HTML', 'function(container, block, inputs, outputs, helpers) { ... }', htmlProp, block, requestRender, persist);
  codeField(container, 'Dialog', 'function(container, block, props, outputs, helpers) { ... }', dialogProp, block, requestRender, persist);

  const testRow = document.createElement('div');
  testRow.className = 'apply-row';
  const testButton = document.createElement('button');
  testButton.type = 'button';
  testButton.textContent = 'Test now';
  const dialogButton = document.createElement('button');
  dialogButton.type = 'button';
  dialogButton.textContent = 'Open dialog';
  dialogButton.addEventListener('click', () => openDialogPreview(block));
  testRow.append(testButton, dialogButton);
  container.appendChild(testRow);

  const resultBox = document.createElement('pre');
  resultBox.className = 'noditron-logic-result';
  container.appendChild(resultBox);

  testButton.addEventListener('click', () => {
    const result = getLastResult();
    const inputs = result.inputsByBlock.get(block.id) || {};
    const outputs = result.outputsByBlock.get(block.id) || {};
    const error = result.errors.get(block.id);
    resultBox.textContent = error
      ? `Error: ${error}`
      : `inputs:  ${JSON.stringify(inputs)}\noutputs: ${JSON.stringify(outputs)}`;
    resultBox.classList.toggle('noditron-logic-result-error', Boolean(error));
  });
}
