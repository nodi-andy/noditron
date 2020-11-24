import { types } from "../../savegame/serialization";
import { NodiComponent } from "../nodi_component";
import { enumNodiTypes } from "../nodisolver";
import { enumNodiBits } from "../nodisolver";


/** @enum {string} */
export const enumNodiOperType = {
    and: "and",
    not: "not",
    xor: "xor",
    or: "or",
    transistor: "transistor",

    analyzer: "analyzer",
    rotater: "rotater",
    unstacker: "unstacker",
    cutter: "cutter",
    compare: "compare",
    stacker: "stacker",
    painter: "painter",
};

export class NodiOperComponent extends NodiComponent {

    static getId() {
        return "NodiOper";
    }

    /**

     */
    constructor(entityFromSystem) {
        super();
        this.storedType = 3;
        this.storedTypeNext = 3;
        this.storedCount = 0;
        this.entity = entityFromSystem;
    }

    nodiProc(map){
        const staticComp = this.entity.components.StaticMapEntity;

        for (var i = 0; i < 8; i++) {
            var NB = this.getNB(i);
            let xt = staticComp.origin.x + NB[0];
            let yt = staticComp.origin.y + NB[1];
            this.ping(map, xt, yt, [enumNodiTypes.COND_2, enumNodiTypes.DISCUS_2]);
        }

        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
        this.storedCount = 0;
    }
}
