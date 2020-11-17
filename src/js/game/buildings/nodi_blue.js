import { enumDirection, Vector } from "../../core/vector";
import { enumPinSlotType, WiredPinsComponent } from "../components/wired_pins";
import { Entity } from "../entity";
import { MetaBuilding } from "../meta_building";
import { GameRoot } from "../root";
import { NodiBlueComponent } from "../components/nodi_blue";
import { enumHubGoalRewards } from "../tutorial_goals";

export class MetaDisplayBuilding extends MetaBuilding {
    constructor() {
        super("display");
    }

    getSilhouetteColor() {
        return "#0088ff";
    }

    /**
     *
     * @param {GameRoot} root
     */
    getAvailableVariants(root) {
        return super.getAvailableVariants(root);
    }
    getDimensions() {
        return new Vector(1, 1);
    }

    getShowWiresLayerPreview() {
        return true;
    }
    getStayInPlacementMode() {
        return true;
    }
    /**
     * Creates the entity at the given location
     * @param {Entity} entity
     */
    setupEntityComponents(entity) {
        entity.addComponent(
            new WiredPinsComponent({
                slots: [
                    {
                        pos: new Vector(0, 0),
                        direction: enumDirection.bottom,
                        type: enumPinSlotType.logicalAcceptor,
                    },
                ],
            })
        );
        entity.addComponent(new NodiBlueComponent(entity));
    }
}
