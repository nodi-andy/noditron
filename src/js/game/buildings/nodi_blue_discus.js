import { generateMatrixRotations } from "../../core/utils";
import { enumDirection, Vector } from "../../core/vector";
import { enumPinSlotType, WiredPinsComponent } from "../components/wired_pins";
import { Entity } from "../entity";
import { MetaBuilding } from "../meta_building";
import { GameRoot } from "../root";
import { NodiBlueDiscusComponent } from "../components/nodi_blue_discus";
import { enumHubGoalRewards } from "../tutorial_goals";

const overlayMatrix = generateMatrixRotations([1, 1, 1, 1, 0, 1, 1, 1, 1]);

export class MetaNodiBlueDiscusBuilding extends MetaBuilding {
    constructor() {
        super("nodi_blue_discus");
    }

    getSilhouetteColor() {
        return "#4C8BF5";
    }
    getSpecialOverlayRenderMatrix(rotation) {
        return overlayMatrix[rotation];
    }
    /**
     * @param {GameRoot} root
     */
    getIsUnlocked(root) {
        return root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_2_nodi_blue_discus);
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

    getStayInPlacementMode() {
        return true;
    }
    /**
     * Creates the entity at the given location
     * @param {Entity} entity
     */
    setupEntityComponents(entity) {
        entity.addComponent(new NodiBlueDiscusComponent(entity));
    }
}
