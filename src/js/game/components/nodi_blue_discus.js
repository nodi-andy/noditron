import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";
import { enumNodiTypes, enumNodiBits } from "../nodi_solver";
import { Entity } from "../entity";

export class NodiBlueDiscusComponent extends NodiComponent {
   static getId() {
        return "NodiBlueDiscus";
    }

    /**

     */
    constructor(entityFromSystem) {
        super();
        this.storedType = enumNodiTypes.DISCUS_1;
        this.storedTypeNext = enumNodiTypes.DISCUS_1;
        this.storedCount = 0;
        this.entity = entityFromSystem;
    }

    nodiProc(map){
        const staticComp = this.entity.components.StaticMapEntity;
        for (var i = 0; i < 8; i++) {
            var NB = this.getNB(i);
            let xt = staticComp.origin.x + NB[0];
            let yt = staticComp.origin.y + NB[1];

            let pingedEntity = map.getLayerContentXY(xt, yt, "regular");
            if(pingedEntity && pingedEntity.components) 
            {
                let pingedNodiData = undefined;
                if(pingedNodiData == undefined) pingedNodiData = pingedEntity.components.NodiLed;
                if(pingedNodiData == undefined) pingedNodiData = pingedEntity.components.NodiData;
                if(pingedNodiData != undefined)
                {
                    // multiple
                    if (i == 1) { this.storedCount *= pingedNodiData.storedCount; }
                    // read
                    if (i == 2) { this.storedCount = pingedNodiData.allowedValue; }
                    // add
                    if (i == 3) { this.storedCount += pingedNodiData.allowedValue; }
                    // compare
                    if (i == 4) {
                        this.storedCount = pingedNodiData.allowedValue - this.storedCount;
                        this.ping(map, xt, yt, [enumNodiTypes.DATA]);
                    }
                    // subtract
                    if (i == 5) { this.storedCount -= pingedNodiData.allowedValue; }
                    // write
                    if (i == 6) { pingedNodiData.storedCount = this.storedCount; }
                }
            }
        }
        // fCond: After calculations are done, send to blue conductor
        for (var i = 0; i < 8; i++) {
            var NB = this.getNB(i);
            let xt = staticComp.origin.x + NB[0];
            let yt = staticComp.origin.y + NB[1];
            this.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1]);
        }
        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
    }
}
