import { NodiComponent } from "../nodi_component";
import { enumNodiTypes, enumNodiBits } from "../nodi_solver";

export class NodiBlueComponent extends NodiComponent {

    static getId() {
        return "NodiBlue";
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
        const staticComp = this.entity.components.StaticMapEntity;
        if(f == undefined){
            for (var i = 0; i < 8; i++) {
                var NB = this.getNB(i);
                let xt = staticComp.origin.x + NB[0];
                let yt = staticComp.origin.y + NB[1];
                this.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1]);
            }
        }

        // read
        if (f == 2) { caller.storedCount = this.storedCount; }
        // add
        if (f == 3) { caller.storedCount += this.storedCount; }
        // compare
        if (f == 4) {
            // equal
            //if (caller.storedCount == this.allowedValue) { this.ping(map, staticComp.origin.x + 1, staticComp.origin.y, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1, enumNodiTypes.COND_2, enumNodiTypes.DISCUS_2]); }
            // bigger
            //if (getV(i, j) > getV(i - 1, j)) { ping(i - 1, j, i + 1, j + 1, [COND_1, DISCUS_1, COND_2, DISCUS_2]); }
            // smaller
            //if (getV(i, j) < getV(i - 1, j)) { ping(i - 1, j, i + 1, j - 1, [COND_1, DISCUS_1, COND_2, DISCUS_2]); }
            // sub
            //setValue(x - 1, y, getV(i, j) - getV(x - 1, y));
        }
        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
    }

}
