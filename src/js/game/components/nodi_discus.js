import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";
import { enumNodiTypes, enumNodiBits } from "../nodisolver";
import { Entity } from "../entity";

export class NodiDiscusComponent extends NodiComponent {
   static getId() {
        return "NodiDiscus";
    }

    /**

     */
    constructor(entityFromSystem) {
        super();
        this.storedType = enumNodiTypes.DISCUS;
        this.storedTypeNext = enumNodiTypes.DISCUS;
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
                if (pingedNodiData !== undefined){
                    pingedNodiData.nodiProc(map, this, i);
                }
            }
        }
        // fCond
        for (var i = 0; i < 8; i++) {
            var NB = this.getNB(i);
            let xt = staticComp.origin.x + NB[0];
            let yt = staticComp.origin.y + NB[1];
            this.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1]);
        }

        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
        this.storedCount = 0;
    }
}
