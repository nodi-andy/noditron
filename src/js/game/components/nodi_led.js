import { enumNodiTypes, enumNodiBits } from "../nodisolver";
import { Entity } from "../entity";
import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";
import { NodiDataComponent } from "./nodi_data";

export class NodiLedComponent extends NodiDataComponent {
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
        else
        {
          this.storedCount = val;
          this.toggled = false;
        }
    }

    nodiHwProc(map, caller){
        const staticComponents = this.entity.components;
        if(caller.entity.components.NodiDiscus)
        {
            this.setNewtypeBit(enumNodiBits.TRAN);
            this.clearNewtypeBit(enumNodiBits.PUSH);
        }
        else if(caller.entity.components.NodiBlue)
        {
            if(this.hasTypeBit(enumNodiBits.PUSH) == 0)
            {
              this.setValue(caller.storedCount);
            }
        }
    }

}
