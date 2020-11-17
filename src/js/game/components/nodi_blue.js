import { types } from "../../savegame/serialization";
import { NodiComponent } from "../nodi_component";
import { enumNodiTypes } from "../nodisolver";
import { enumNodiBits } from "../nodisolver";

export class NodiBlueComponent extends NodiComponent {

    static getId() {
        return "Display";
    }

    /**
     * 
     */
    constructor(entityFromSystem) {
        super();
        this.storedType = enumNodiTypes.COND_1;
        this.storedTypeNext = enumNodiTypes.COND_1;
        this.storedCount = 0;
        this.entity = entityFromSystem;
    }
    // Derived from NodiComponent
    setValue(val)
    {
        this.storedCount = val;
    }

    nodiProc(map, caller, f){
        if(f == undefined){
            const staticComp = this.entity.components.StaticMapEntity;
            for (var i = 0; i < 8; i++) {
                var NB = this.getNB(i);
                let xt = staticComp.origin.x + NB[0];
                let yt = staticComp.origin.y + NB[1];
                this.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS]);
            }
        }

        // read
        if (f == 2) { caller.storedCount = this.storedCount; }
        // add
        if (f == 3) { caller.storedCount += this.storedCount; }

        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
    }

}
