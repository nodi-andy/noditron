import { createLogger } from "../core/logging";
import { GameRoot } from "./root";
import { enumNotificationType } from "../game/hud/parts/notifications";
import { MinerComponent } from "./components/miner";


/**
 * @enum {number}
 */
export const enumNodiBits = {
    LAYER: 0,
    COND: 1,
    PROC: 2,
    TRAN: 3,
    PUSH: 4
};

/****************************************
* DEFINES
*/

export const enumNodiTypes = {
    SPACE       : 0,                         // 0 Nothing, do nothing
    SUPRACOND   : 1,                         // 1 ping all neighbouring conductors
    COND_1      : enumNodiBits.COND << 1,                       // 2 ping only blue conductor and blue discus
    COND_2      : (enumNodiBits.COND << 1) + 1,                 // 3 ping only red conductor and red discus
    DATA        : enumNodiBits.PROC << 1,                         // 4 I can keep the cell value and make basic calculation
    LINK        : (enumNodiBits.PROC << 1) + 1,                   // 5 Process unit. I get getrigged by a discus and have my custom function, see LINKTYPE
    DISCUS_1    : (enumNodiBits.COND << 1) + (enumNodiBits.PROC << 1),       // 6 A blue discus executes a function call in blue layer
    DISCUS_2    : (enumNodiBits.COND << 1) + (enumNodiBits.PROC << 1) + 1,  // 7 A red discus executes a function call in red layer
}
// How important it is that a savegame is created
/**
 * @enum {number}
 */
export const enumSavePriority = {
    regular: 2,
    asap: 100,
};


export class NodiSolver {
    constructor(root) {
        /** @type {GameRoot} */
        this.root = root;

        // Store the current maximum save importance
        this.saveImportance = enumSavePriority.regular;

        this.lastSaveAttempt = -1000;

        this.lastSaveTime = 0;

        this.noditick = 0;

        this.tickrate = 200;

        this.nodistate = 0;
    }




    clearNewtypeBit(x, y, b) {
        let newType = this.getNewType(x,y) & ~(1 << b);
        this.setNewType(x,y,newType);
    }

    getType(x, y)
    {
        let ret = 0;
        const entity = this.root.map.getLayerContentXY(x, y, "regular");
        if(entity)
        { 
            const displayCompent = entity.components.NodiBlue;
            if(displayCompent) ret = displayCompent.storedType;
        }
        return ret;
    }

    getNewType(x, y)
    {
        let ret = 0;
        const entity = this.root.map.getLayerContentXY(x, y, "regular");
        if(entity)
        { 
            const displayCompent = entity.components.NodiBlue;
            if(displayCompent) ret = displayCompent.storedTypeNext;
        }
        return ret;
    }

    setNewType(x, y, v)
    {
        const entity = this.root.map.getLayerContentXY(x, y, "regular");
        if(entity)
        { 
            const displayCompent = entity.components.NodiBlue;
            if(displayCompent) displayCompent.storedTypeNext = v;
        }
    }

    setValue(x, y, v)
    {
        const entity = this.root.map.getLayerContentXY(x, y, "regular");
        if(entity)
        { 
            const displayCompent = entity.components.NodiBlue;
            if(displayCompent) displayCompent.storedCount = v;
        }
    }

    doSave() {
        if(this.noditick == 0)
        {
            for (let i = 0; i < this.root.entityMgr.getAllWithComponent(MinerComponent).length ; ++i) {
                let minerEntity = this.root.entityMgr.getAllWithComponent(MinerComponent)[i];
                let x = minerEntity.components.StaticMapEntity.origin.x;
                let y = minerEntity.components.StaticMapEntity.origin.y;
                const entityNB = this.root.map.getLayerContentXY(x, y-1, "regular");
                if(entityNB)
                { 
                    const dispCompNB = entityNB.components.NodiBlue;
                    if (dispCompNB) {
                        dispCompNB.setTypeBit(enumNodiBits.TRAN);
                        dispCompNB.storedCount = 77;
                    }
                }
            }
        }

        for (let i = 0; i < this.root.entityMgr.entities.length; ++i) {
            const entity = this.root.entityMgr.entities[i];
            let displayComp = undefined;
            if(displayComp == undefined) displayComp = entity.components.NodiBlue;
            if(displayComp == undefined) displayComp = entity.components.nodi_button;
            if(displayComp == undefined) displayComp = entity.components.DisplayRed;
            if(displayComp == undefined) displayComp = entity.components.NodiData;
            if(displayComp == undefined) displayComp = entity.components.NodiDiscus;
            if(displayComp && displayComp.hasTypeBit(enumNodiBits.TRAN))
            {
                displayComp.nodiProc(this.root.map);
            }
        }

        // clean PUSH's
        for (let i = 0; i < this.root.entityMgr.entities.length; ++i) {
            const entity = this.root.entityMgr.entities[i];
           let displayComp = undefined;
            if(displayComp == undefined) displayComp = entity.components.NodiBlue;
            if(displayComp == undefined) displayComp = entity.components.nodi_button;
            if(displayComp == undefined) displayComp = entity.components.DisplayRed;
            if(displayComp == undefined) displayComp = entity.components.NodiData;
            if(displayComp == undefined) displayComp = entity.components.NodiDiscus;
            if(displayComp && displayComp.hasTypeBit(enumNodiBits.PUSH))
            {
                displayComp.clearNewtypeBit(enumNodiBits.PUSH);
            }
        }

        // copy new matrix onto current
        for (let i = 0; i < this.root.entityMgr.entities.length; ++i) {
            const entity = this.root.entityMgr.entities[i];
           let displayComp = undefined;
            if(displayComp == undefined) displayComp = entity.components.NodiBlue;
            if(displayComp == undefined) displayComp = entity.components.nodi_button;
            if(displayComp == undefined) displayComp = entity.components.DisplayRed;
            if(displayComp == undefined) displayComp = entity.components.NodiData;
            if(displayComp == undefined) displayComp = entity.components.NodiDiscus;
            if(displayComp)
            {
                displayComp.storedType = displayComp.storedTypeNext;
            }
        }
        
        this.root.nodiSolver.noditick++;
        this.root.hud.parts.timeController.showNodiTick(this.root.nodiSolver.noditick);
        this.root.hubGoals.getCurrentGoalDelivered();

    }

    update() {
        if (!this.root.gameInitialized) {
            // Bad idea
            return;
        }

        if (this.tickrate == 0) {
            // Disabled
            return;
        }

        // Check when the last save was, but make sure that if it fails, we don't spam

        const secondsSinceLastSave = performance.now() - this.lastSaveTime;

        let shouldSave = secondsSinceLastSave > this.tickrate;
        if(this.nodistate == 0) shouldSave = false;

        if (shouldSave) {
            //logger.log("Saving automatically");
            this.lastSaveTime =  performance.now();
            this.doSave();
        }
    }
}
