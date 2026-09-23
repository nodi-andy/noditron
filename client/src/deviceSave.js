import { collectEsp32DevkitBlocks, isDevkitDirty, isDevkitRunning, buildDevkitDesign, devkitSnapshot, markDevkitSent } from './devkitCircuit.js';

// A device acknowledgement is part of an explicit Save, including deleting
// the final block. Keep concurrent Save requests on the same ordered path.
export function createDeviceSaver({ project, getSession, sendDesign, persist, openDialog }) {
  let pending = Promise.resolve();
  return () => {
    const result = pending.then(async () => {
      for (const { block, level } of collectEsp32DevkitBlocks(project.rootBlock.children)) {
        if (!isDevkitDirty(block, level)) continue;
        if (!getSession(block.id) || !isDevkitRunning(block)) {
          openDialog(block);
          throw new Error(`Connect ${block.name} to save its circuit.`);
        }
        const snapshot = devkitSnapshot(block, level);
        const design = buildDevkitDesign(block, level);
        await sendDesign(block.id, design);
        markDevkitSent(block, snapshot);
        persist();
      }
    });
    pending = result.catch(() => {});
    return result;
  };
}
