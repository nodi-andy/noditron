import { generateMatrixRotations } from "../../core/utils";
import { enumDirection, Vector } from "../../core/vector";
import { enumPinSlotType, WiredPinsComponent } from "../components/wired_pins";
import { Entity } from "../entity";
import { MetaBuilding } from "../meta_building";
import { GameRoot } from "../root";
import { NodiButtonComponent } from "../components/nodi_button";
import { enumHubGoalRewards } from "../tutorial_goals";


const overlayMatrix = generateMatrixRotations([1, 1, 0, 1, 1, 1, 0, 1, 0]);

export class MetaNodiButtonBuilding extends MetaBuilding {
    constructor() {
        super("nodi_button");
    }

    getSilhouetteColor() {
        // @todo: Render differently based on if its activated or not
        return "#ff678b";
    }

    /**
     * @param {GameRoot} root
     */
    getIsUnlocked(root) {
        return root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_wires_painter_and_levers);
    }

    /** @returns {"wires"} **/
    getLayer() {
        return "wires";
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
        entity.addComponent(
            new WiredPinsComponent({
                slots: [
                    {
                        pos: new Vector(0, 0),
                        direction: enumDirection.top,
                        type: enumPinSlotType.logicalEjector,
                    },
                ],
            })
        );

        entity.addComponent(new NodiButtonComponent({entity}));
    }
}
