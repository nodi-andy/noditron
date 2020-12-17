import { NodiComponent } from "../nodi_component";
import { types } from "../../savegame/serialization";
import { enumNodiTypes, enumNodiBits } from "../nodi_solver";
import { NodiBlueComponent } from "./nodi_blue";
import { Entity } from "../entity";

export class NodiButtonComponent extends NodiComponent {
    static getId() {
        return "NodiButton";
    }

    static getSchema() {
        return {
            storedCount: types.int,
            storedType: types.int,
            toggled: types.bool,
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
        super();
        this.toggled = toggled;
        this.storedCount = 0;
        this.entity = entity;
    }

    // Derived from DisplayComponent
    setValue(val) {
        this.storedCount = val;
        this.toggled = val;
    }

    toggleSignal(map) {
        this.setTypeBit(enumNodiBits.PUSH);
        const staticComp = this.entity.components.StaticMapEntity;
        if(staticComp == undefined) return;

        let pingedEntity = map.getLayerContentXY(staticComp.origin.x, staticComp.origin.y, "regular");
        if (pingedEntity && pingedEntity.components) {
            let pingedComp = undefined;
            if (pingedComp == undefined) pingedComp = pingedEntity.components.NodiBlue;
            if (pingedComp) {
                pingedComp.setNewtypeBit(enumNodiBits.TRAN);
                pingedComp.clearNewtypeBit(enumNodiBits.PUSH);
                pingedComp.setValue(this.storedCount);
            }
        }
    }
}
