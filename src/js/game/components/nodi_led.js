import { enumNodiTypes, enumNodiBits } from "../nodisolver";
import { Entity } from "../entity";
import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";

export class NodiLedComponent extends NodiComponent {
    static getId() {
        return "NodiLed";
    }
    static getSchema() {
        return {
            storedCount: types.int,
            storedType: types.int,
            allowedValue: types.int,
            toggled: types.bool
        };
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
        super();
        this.toggled = toggled;
        this.allowedValue = 1;
        this.entity = entity;
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

    nodiHwProc(map, caller){
        const staticComponents = this.entity.components;
        if(caller.entity.components.NodiDiscus)
        {
            const staticCompCaller = caller.entity.components.StaticMapEntity;
            const staticCompThis = this.entity.components.StaticMapEntity;
            let f = 0;
            if(staticCompCaller.origin.x == staticCompThis.origin.x - 1 && staticCompCaller.origin.y == staticCompThis.origin.y)
            {
              f = 4;
            }
            this.nodiProc(map, caller, f);
        }
        else
        {
            if(staticComponents.NodiData)
            {
              this.setValue(caller.storedCount);
            }
        }
    }

    nodiProc(map, caller, f) {
        const staticComponents = this.entity.components;
        let nodiData = staticComponents.NodiData;
        if(nodiData) {
            const staticComp = this.entity.components.StaticMapEntity;
            if(f == undefined) {
                for (var i = 0; i < 8; i++) {
                    var NB = nodiData.getNB(i);
                    let xt = staticComp.origin.x + NB[0];
                    let yt = staticComp.origin.y + NB[1];
                    nodiData.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1]);
                }
            }

            // read
            if (f == 2) { caller.storedCount = this.storedCount; }
            // add
            if (f == 3) { caller.storedCount += this.storedCount; }
            // compare
            if (f == 4) {
                // equal
                if (caller.storedCount == this.allowedValue) { nodiData.ping(map, staticComp.origin.x + 1, staticComp.origin.y, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1, enumNodiTypes.COND_2, enumNodiTypes.DISCUS_2], this.allowedValue); }
                // bigger
                //if (getV(i, j) > getV(i - 1, j)) { ping(i - 1, j, i + 1, j + 1, [COND_1, DISCUS_1, COND_2, DISCUS_2]); }
                // smaller
                //if (getV(i, j) < getV(i - 1, j)) { ping(i - 1, j, i + 1, j - 1, [COND_1, DISCUS_1, COND_2, DISCUS_2]); }
                // sub
                //setValue(x - 1, y, getV(i, j) - getV(x - 1, y));
            }
            // multiple
            if (f == 5) { caller.storedCount *= this.storedCount; }
            nodiData.clearNewtypeBit(enumNodiBits.TRAN);
            nodiData.setNewtypeBit(enumNodiBits.PUSH);
        }
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
