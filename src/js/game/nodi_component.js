import { types } from "../savegame/serialization";
import { Component } from "./component";
import { enumNodiBits } from "./nodi_solver";
import { GameRoot } from "./root";

export class NodiComponent extends Component {
    static getId() {
        return "unknown-component";
    }

    setValue(val) {
        this.storedCount = val;
    }

    /**

     */
    constructor() {
        super();

        /**
         * Currently stored item
         *
         */
        this.storedCount = 0;
        this.storedCountNext = 0;
        this.entity = null;

        /**
         * How many of this item we have stored
         */
        this.storedType = 0;
        this.storedTypeNext = 0;

        /**
         * We compute an opacity to make sure it doesn't flicker
         */
        this.overlayOpacity = 0;
    }

    // a cell at (xf, yf) pings another cell at (xt, yt) and
    // conducts the value v if the second cell has one of the types from "types"
    ping(map, xt, yt, types, v) {
        if (v == undefined) {
            v = this.storedCount;
        }
        let pingedEntity = map.getLayerContentXY(xt, yt, "regular");
        if (pingedEntity && pingedEntity.components) {
            let pingedComp = undefined;
            if (pingedComp == undefined) pingedComp = pingedEntity.components.NodiBlue;
            if (pingedComp == undefined) pingedComp = pingedEntity.components.DisplayRed;
            if (pingedComp == undefined) pingedComp = pingedEntity.components.NodiData;
            if (pingedComp == undefined) pingedComp = pingedEntity.components.NodiBlueDiscus;
            if (pingedComp == undefined) return;

            if (types.includes(pingedComp.storedType)) {
                pingedComp.setNewtypeBit(enumNodiBits.TRAN);
                pingedComp.clearNewtypeBit(enumNodiBits.PUSH);
                pingedComp.setValue(v);
            }
        }
    }
    // i: Neighbour ID, beginning 0 = left neighbour, rotate CW
    // return x,y values, which can only be -1, 0 or 1
    getNB(i) {
        var x, y;
        if (i == 0) {
            x = -1;
            y = 0;
        } else if (i == 1) {
            x = -1;
            y = -1;
        } else if (i == 2) {
            x = 0;
            y = -1;
        } else if (i == 3) {
            x = 1;
            y = -1;
        } else if (i == 4) {
            x = 1;
            y = 0;
        } else if (i == 5) {
            x = 1;
            y = 1;
        } else if (i == 6) {
            x = 0;
            y = 1;
        } else if (i == 7) {
            x = -1;
            y = 1;
        } else {
            x = 0;
            y = 0;
        }
        return [x, y];
    }

    hasTypeBit(b) {
        return this.storedType & (1 << b);
    }

    clearNewtypeBit(b) {
        this.storedTypeNext &= ~(1 << b);
    }

    setTypeBit(b) {
        this.storedType |= 1 << b;
    }

    // Set and clean a bit (COND, PROC etc.) on the new-matrix
    setNewtypeBit(b) {
        this.storedTypeNext |= 1 << b;
    }
}
