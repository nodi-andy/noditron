import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";
import { enumNodiTypes, enumNodiBits } from "../nodisolver";
import { DisplayComponent } from "./display";
import { Entity } from "../entity";

export class NodiLedComponent extends DisplayComponent {
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
    }

    // Derived from DisplayComponent
    setValue(val)
    {
        this.storedCount = val;
        this.toggled = val;
    }

    toggleSignal(map)
    {
        if(this.toggled)
          this.storedCount = 1;
        else
          this.storedCount = 0;
        this.setTypeBit(enumNodiBits.PUSH);
        this.nodiProc(map);
    }
}
