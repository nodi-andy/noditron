import { STOP_PROPAGATION } from "../../../core/signal";
import { Vector } from "../../../core/vector";
import { enumMouseButton } from "../../camera";
import { BaseHUDPart } from "../base_hud_part";

export class HUDNodiButtonToggle extends BaseHUDPart {
    initialize() {
        this.root.camera.downPreHandler.add(this.downPreHandler, this);
        this.root.camera.upPostHandler.add(this.upPostHandler, this);
    }

    /**
     * @param {Vector} pos
     * @param {enumMouseButton} button
     */
    downPreHandler(pos, button) {
        if(this.root.nodiSolver.nodistate == 1)
        {
          const tile = this.root.camera.screenToWorld(pos).toTileSpace();
          const contents = this.root.map.getLayerContentXY(tile.x, tile.y, "wires");
          if (contents) {
            const buttonComp = contents.components.NodiButton;
            if (buttonComp) {
                if (button === enumMouseButton.left) {
                    buttonComp.toggled = true;
                    buttonComp.toggleSignal(this.root.map);
                    return STOP_PROPAGATION;
                } else if (button === enumMouseButton.right) {
                    this.root.logic.tryDeleteBuilding(contents);
                    return STOP_PROPAGATION;
                }
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
            const buttonComp = contents.components.NodiButton;
            if (buttonComp) 
            {
                buttonComp.toggled = false;
                return STOP_PROPAGATION;
            }
        }
    }
}
