import { types } from "../../savegame/serialization";
import { Component } from "../component";

export class DisplayComponent extends Component {
    static getId() {
        return "Display";
    }
    static getSchema() {
        return {
            storedCount: types.uint,
            storedType: types.uint
        };
    }

    /**
     * @param {object} param0
     * @param {number=} param0.maximumStorage How much this storage can hold
     */
    constructor() {
        super();

        /**
         * Currently stored item
         * @type {BaseItem}
         */
        this.storedCount = 17;

        /**
         * How many of this item we have stored
         */
        this.storedType = 13;

        /**
         * We compute an opacity to make sure it doesn't flicker
         */
        this.overlayOpacity = 0;
    }
}
