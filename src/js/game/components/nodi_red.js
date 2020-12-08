import { NodiComponent } from "../nodi_component";
import { enumNodiTypes } from "../nodi_solver";
import { enumNodiBits } from "../nodi_solver";

export class NodiRedComponent extends NodiComponent {

    static getId() {
        return "NodiRed";
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
