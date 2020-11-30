import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";
import { enumNodiTypes, enumNodiBits } from "../nodisolver";
import { NodiBlueComponent } from "./nodi_blue";
import { Entity } from "../entity";

export class NodiButtonComponent extends NodiBlueComponent {
    static getId() {
        return "NodiButton";
    }

    static getSchema() {
        return {
            storedCount: types.int,
            storedType: types.int,
            toggled: types.bool
        };
    }

    /**
     * Copy the current state to another component
     * @param {NodiButtonComponent} otherComponent
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
        this.setTypeBit(enumNodiBits.PUSH);
        this.nodiProc(map);
    }
}
