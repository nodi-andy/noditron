import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";
import { enumNodiTypes, enumNodiBits } from "../nodisolver";
import { NodiDataComponent } from "./nodi_data";
import { Entity } from "../entity";

export class NodiLedComponent extends NodiDataComponent {
    static getId() {
        return "NodiLed";
    }

    /**
     * Copy the current state to another component
     * @param {NodiLedComponent} otherComponent
     */
    copyAdditionalStateTo(otherComponent) {
        otherComponent.toggled = this.toggled;
    }

    /**
     * @param {object} param0
     * @param {Entity} param0.entity
     * @param {boolean=} param0.toggled
     */
    constructor({ entity, toggled = false }) {
        super(entity);
        this.toggled = toggled;
        this.allowedValue = 1;
    }

    // Derived from DisplayComponent
    setValue(val)
    {
        if(val == this.allowedValue)
        {
          this.storedCount = val;
          this.toggled = true;
        }
        if(val == 0)
        {
          this.storedCount = val;
          this.toggled = false;
        }
    }

    nodiProc(map, caller, f){
        const staticComp = this.entity.components.StaticMapEntity;
        if(f == undefined){
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
        // compare
        if (f == 4) {
            // equal
            if (caller.storedCount == this.allowedValue) { this.ping(map, staticComp.origin.x + 1, staticComp.origin.y, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS, enumNodiTypes.COND_2, enumNodiTypes.DISCUS_2]); }
            // bigger
            //if (getV(i, j) > getV(i - 1, j)) { ping(i - 1, j, i + 1, j + 1, [COND_1, DISCUS, COND_2, DISCUS_2]); }
            // smaller
            //if (getV(i, j) < getV(i - 1, j)) { ping(i - 1, j, i + 1, j - 1, [COND_1, DISCUS, COND_2, DISCUS_2]); }
            // sub
            //setValue(x - 1, y, getV(i, j) - getV(x - 1, y));
        }
        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
    }
   /* toggleSignal(map)
    {
        if(this.toggled)
          this.storedCount = 1;
        else
          this.storedCount = 0;
        this.setTypeBit(enumNodiBits.PUSH);
        this.nodiProc(map);
    }*/
}
