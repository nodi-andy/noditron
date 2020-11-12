import { enumDirection, Vector } from "../../core/vector";
import { enumPinSlotType, WiredPinsComponent } from "../components/wired_pins";
import { Entity } from "../entity";
import { MetaBuilding } from "../meta_building";
import { GameRoot } from "../root";
import { NodiDiscusComponent } from "../components/nodi_discus";
import { enumHubGoalRewards } from "../tutorial_goals";

export class MetaNodiDiscusBuilding extends MetaBuilding {
    constructor() {
        super("nodi_discus");
    }

    getSilhouetteColor() {
        return "#4C8BF5";
    }

    /**
     * @param {GameRoot} root
     */
    getIsUnlocked(root) {
        return root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_cutter_and_trash);
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
        entity.addComponent(new NodiDiscusComponent(entity));
    }
}
