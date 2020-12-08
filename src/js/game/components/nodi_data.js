import { types } from "../../savegame/serialization";
import { NodiComponent } from "../nodi_component";
import { enumNodiTypes, enumNodiBits } from "../nodi_solver";

export class NodiDataComponent extends NodiComponent {

    static getId() {
        return "NodiData";
    }
 
     getSilhouetteColor() {
        return "#11ff11";
    }
       /**

     */
    constructor(entityFromSystem) {
        super();
        this.storedType = 4;
        this.entity = entityFromSystem;
    }
    
    nodiProc(map, caller, f)
    {
        const staticComp = this.entity.components.StaticMapEntity;
        if(f == undefined) {
            for (var i = 0; i < 8; i++) {
                var NB = this.getNB(i);
                let xt = staticComp.origin.x + NB[0];
                let yt = staticComp.origin.y + NB[1];
                let pingerEntity = map.getLayerContentXY(xt, yt, "regular");
                if(pingerEntity && pingerEntity.components && pingerEntity.components.NodiDiscus && pingerEntity.components.NodiDiscus.hasTypeBit(enumNodiBits.PUSH)) 
                {
                    f = i;
                    caller = pingerEntity.components.NodiDiscus;
                }

                //this.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1]);
            }
        }
        // multiple
        if (f == 5) { caller.storedCount *= this.storedCount; }
        // read
        if (f == 6) { caller.storedCount = this.allowedValue; }
        // add
        if (f == 7) { caller.storedCount += this.allowedValue; }
        // compare
        if (f == 0) {
            let correctedInputValue = this.allowedValue - caller.storedCount;
            // equal
            if (correctedInputValue == this.allowedValue) { this.ping(map, staticComp.origin.x + 1, staticComp.origin.y, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1, enumNodiTypes.COND_2, enumNodiTypes.DISCUS_2], correctedInputValue); }
            // bigger
            if (correctedInputValue > this.allowedValue) { this.ping(map, staticComp.origin.x + 1, staticComp.origin.y-1, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1, enumNodiTypes.COND_2, enumNodiTypes.DISCUS_2], correctedInputValue); }
            // smaller
            if (correctedInputValue < this.allowedValue) { this.ping(map, staticComp.origin.x + 1, staticComp.origin.y+1, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1, enumNodiTypes.COND_2, enumNodiTypes.DISCUS_2], correctedInputValue); }
            // sub
            //setValue(x - 1, y, getV(i, j) - getV(x - 1, y));
        }
        // subtract
        if (f == 1) { caller.storedCount = this.allowedValue - caller.storedCount; }
        // write
        if (f == 2) { this.allowedValue = caller.storedCount; }

        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
    }
}
