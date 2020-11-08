import { types } from "../savegame/serialization";
import { Component } from "./component";

export class NodiComponent extends Component {
    static getId() {
        return "unknown-component";
    }
    static getSchema() {
        return {
            storedCount: types.uint,
            storedType: types.uint
        };
    }

    /**

     */
    constructor() {
        super();

        /**
         * Currently stored item
         * 
         */
        this.storedCount = 17;
        this.storedCountNext = 18;

        /**
         * How many of this item we have stored
         */
        this.storedType = 2;
        this.storedTypeNext = 2;

        /**
         * We compute an opacity to make sure it doesn't flicker
         */
        this.overlayOpacity = 0;
    }
}
