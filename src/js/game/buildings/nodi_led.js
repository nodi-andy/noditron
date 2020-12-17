import { enumDirection, Vector } from "../../core/vector";
import { enumPinSlotType, WiredPinsComponent } from "../components/wired_pins";
import { Entity } from "../entity";
import { MetaBuilding } from "../meta_building";
import { GameRoot } from "../root";
import { NodiLedComponent } from "../components/nodi_led";
import { enumHubGoalRewards } from "../tutorial_goals";

export class MetaNodiLedBuilding extends MetaBuilding {
    constructor() {
        super("nodi_led");
        this.isRemovable = false;
    }

    getSilhouetteColor() {
        // @todo: Render differently based on if its activated or not
        return "#ff678b";
    }

    getStayInPlacementMode() {
        return true;
    }

    getIsRemovable() {
        return this.isRemovable;
    }

    /** @returns {"wires"} **/
    getLayer() {
        return "wires";
    }

    /**
     * @param {GameRoot} root
     */
    getIsUnlocked(root) {
        return root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_logic_gates);
    }

    getDimensions() {
        return new Vector(1, 1);
    }

    getSprite() {
        return null;
    }

    /**
     * Creates the entity at the given location
     * @param {Entity} entity
     */
    setupEntityComponents(entity) {
        entity.addComponent(new NodiLedComponent({ entity }));
    }
}
