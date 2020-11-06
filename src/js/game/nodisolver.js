import { globalConfig } from "../core/config";
import { createLogger } from "../core/logging";
import { GameRoot } from "./root";

// How important it is that a savegame is created
/**
 * @enum {number}
 */
export const enumSavePriority = {
    regular: 2,
    asap: 100,
};

const logger = createLogger("autosave");

export class NodiSolver {
    constructor(root) {
        /** @type {GameRoot} */
        this.root = root;

        // Store the current maximum save importance
        this.saveImportance = enumSavePriority.regular;

        this.lastSaveAttempt = -1000;

        this.lastSaveTime = 0;
    }

    doSave() {
        if (G_IS_DEV && globalConfig.debug.disableSavegameWrite) {
            return;
        }

        this.root.gameState.doNodiStep();
    }

    update() {
        if (!this.root.gameInitialized) {
            // Bad idea
            return;
        }

        if (this.root.tickrate == 0) {
            // Disabled
            return;
        }

        // Check when the last save was, but make sure that if it fails, we don't spam

        const secondsSinceLastSave = performance.now()- this.lastSaveTime;

        let shouldSave = secondsSinceLastSave > this.root.tickrate;

        if (shouldSave) {
            //logger.log("Saving automatically");
            this.lastSaveTime =  performance.now();
            this.doSave();
        }
    }
}
