import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";
import { enumNodiTypes, enumNodiBits } from "../nodisolver";
import { NodiBlueComponent } from "./nodi_blue";
import { Entity } from "../entity";

export class NodiLedComponent extends NodiBlueComponent {
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
