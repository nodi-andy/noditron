import { collectEsp32DevkitBlocks, isDevkitRunning, buildDevkitDesign, markDevkitSent } from './devkitCircuit.js';
import { showToast } from '/nodigraph/src/ui/Toast.js';

// A device acknowledgement is part of an explicit Save, including deleting
// the final block. Keep concurrent Save requests on the same ordered path.
// Resolves to a line naming the boards that took their circuit ("Circuit
// sent to esp32-S3."), which nodigraph's Save shows in place of its own
// "Saved in this browser" — or to nothing when there was no board to send
// to, and the plain wording stands.
export function createDeviceSaver({ project, getSession, sendDesign, persist, openDialog }) {
  let pending = Promise.resolve();
  return () => {
    const result = pending.then(async () => {
      const sent = [];
      const notes = [];
      for (const { block, level } of collectEsp32DevkitBlocks(project.rootBlock.children)) {
        if (!getSession(block.id) || !isDevkitRunning(block)) {
          openDialog(block);
          throw new Error(`Connect ${block.name} to save its circuit.`);
        }
        const design = buildDevkitDesign(block, level, { notes });
        showToast(`Uploading circuit to ${block.name || 'the board'}…`, { actions: [], autoDismissMs: 2500 });
        await sendDesign(block.id, design);
        markDevkitSent(block, design);
        persist();
        sent.push(block.name || 'the board');
      }
      if (!sent.length) return undefined;
      // What the board did not get still has to be said with the send — a
      // Save that reads as complete while half the drawing stayed behind
      // has cost real debugging time — but as a one-line count, not the
      // full wording per wire: that goes to the browser console, deduped
      // (the compiler repeats itself per chain).
      const unique = [...new Set(notes)];
      if (unique.length) console.info(`Not on the board:\n${unique.join('\n')}`);
      return `Circuit sent to ${sent.join(', ')}.${unique.length ? ` ${unique.length} wire(s) left out — details in the browser console.` : ''}`;
    });
    pending = result.catch(() => {});
    return result;
  };
}
