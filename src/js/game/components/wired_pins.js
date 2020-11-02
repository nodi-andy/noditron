import { enumDirection, Vector } from "../../core/vector";
import { BaseItem } from "../base_item";
import { Component } from "../component";
import { types } from "../../savegame/serialization";
import { typeItemSingleton } from "../item_resolver";

/** @enum {string} */
export const enumPinSlotType = {
    logicalEjector: "logicalEjector",
    logicalAcceptor: "logicalAcceptor",
};

/** @typedef {{
 *   pos: Vector,
 *   type: enumPinSlotType,
 *   direction: enumDirection
 *   nodiType: number,
 *   nodiVal: number
 * }} WirePinSlotDefinition */

/** @typedef {{
 *   pos: Vector,
 *   type: enumPinSlotType,
 *   direction: enumDirection,
 *   nodiType: number,
 *   nodiVal: number,
 *   value: BaseItem,
 *   linkedNetwork: import("../systems/wire").WireNetwork
 * }} WirePinSlot */

export class WiredPinsComponent extends Component {
    static getId() {
        return "WiredPins";
    }

    static getSchema() {
        return {
            slots: types.fixedSizeArray(
                types.structured({
                    value: types.nullable(typeItemSingleton),
                    nodiType: types.int,
                    nodiVal: types.int
                })
            ),
        };
    }

    /**
     *
     * @param {object} param0
     * @param {Array<WirePinSlotDefinition>} param0.slots
     */
    constructor({ slots = [] }) {
        super();
        this.setSlots(slots);
    }

    /**
     * Sets the slots of this building
     * @param {Array<WirePinSlotDefinition>} slots
     */
    setSlots(slots) {
        /** @type {Array<WirePinSlot>} */
        this.slots = [];

        for (let i = 0; i < slots.length; ++i) {
            const slotData = slots[i];
            this.slots.push({
                pos: slotData.pos,
                type: slotData.type,
                direction: slotData.direction,
                nodiType : 33,
                nodiVal : 22,
                value: null,
                linkedNetwork: null,
            });
        }
    }
}
