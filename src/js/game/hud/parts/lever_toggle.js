import { STOP_PROPAGATION } from "../../../core/signal";
import { Vector } from "../../../core/vector";
import { enumMouseButton } from "../../camera";
import { BaseHUDPart } from "../base_hud_part";

export class HUDLeverToggle extends BaseHUDPart {
    initialize() {
        this.root.camera.downPreHandler.add(this.downPreHandler, this);
        this.root.camera.upPostHandler.add(this.upPostHandler, this);
    }

    /**
     * @param {Vector} pos
     * @param {enumMouseButton} button
     */
    downPreHandler(pos, button) {
        const tile = this.root.camera.screenToWorld(pos).toTileSpace();
        const contents = this.root.map.getLayerContentXY(tile.x, tile.y, "wires");
        if (contents) {
            const leverComp = contents.components.Lever;
            if (leverComp) {
                if (button === enumMouseButton.left) {
                    leverComp.toggled = true;
                    leverComp.toggleSignal(this.root.map);
                    return STOP_PROPAGATION;
                } else if (button === enumMouseButton.right) {
                    this.root.logic.tryDeleteBuilding(contents);
                    return STOP_PROPAGATION;
                }
            }
        }
    }

        /**
     * @param {Vector} pos
     */
    upPostHandler(pos) {
        const tile = this.root.camera.screenToWorld(pos).toTileSpace();
        const contents = this.root.map.getLayerContentXY(tile.x, tile.y, "wires");
        if (contents) {
            const leverComp = contents.components.Lever;
            if (leverComp) 
            {
                leverComp.toggled = false;
                //leverComp.toggleSignal(this.root.map);
                return STOP_PROPAGATION;
            }
        }
    }
}
