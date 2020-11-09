import { types } from "../../savegame/serialization";
import { NodiComponent } from "../nodi_component";
import { enumNodiTypes } from "../nodisolver";
import { enumNodiBits } from "../nodisolver";

export class DisplayComponent extends NodiComponent {

    static getId() {
        return "Display";
    }

    /**
     * 
     */
    constructor(entityFromSystem) {
        super();
        this.storedType = 2;
        this.storedTypeNext = 2;
        this.storedCount = 0;
        this.entity = entityFromSystem;
    }

    nodiProc(map){
        const staticComp = this.entity.components.StaticMapEntity;
        for (var i = 0; i < 8; i++) {
            var NB = this.getNB(i);
            let xt = staticComp.origin.x + NB[0];
            let yt = staticComp.origin.y + NB[1];
            this.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS]);
        }

        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
        this.storedCount = 0;
    }

}
