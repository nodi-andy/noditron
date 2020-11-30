import { enumDirection, Vector } from "../../core/vector";
import { enumPinSlotType, WiredPinsComponent } from "../components/wired_pins";
import { Entity } from "../entity";
import { MetaBuilding, defaultBuildingVariant} from "../meta_building";
import { GameRoot } from "../root";
import { enumNodiOperType, NodiOperComponent } from "../components/nodi_oper";
import { generateMatrixRotations } from "../../core/utils";
import { enumHubGoalRewards } from "../tutorial_goals";

/** @enum {string} */
export const enumNodiOperVariants = {
    not: "not",
    xor: "xor",
    or: "or",
};

/** @enum {string} */
export const enumVariantToGate = {
    [defaultBuildingVariant]: enumNodiOperType.and,
    [enumNodiOperVariants.not]: enumNodiOperType.not,
    [enumNodiOperVariants.xor]: enumNodiOperType.xor,
    [enumNodiOperVariants.or]: enumNodiOperType.or,
};

const overlayMatrices = {
    [defaultBuildingVariant]: generateMatrixRotations([0, 1, 0, 1, 1, 1, 0, 1, 1]),
    [enumNodiOperVariants.xor]: generateMatrixRotations([0, 1, 0, 1, 1, 1, 0, 1, 1]),
    [enumNodiOperVariants.or]: generateMatrixRotations([0, 1, 0, 1, 1, 1, 0, 1, 1]),
    [enumNodiOperVariants.not]: generateMatrixRotations([0, 1, 0, 0, 1, 0, 0, 1, 0]),
};

const colors = {
    [defaultBuildingVariant]: "#f48d41",
    [enumNodiOperVariants.xor]: "#f4a241",
    [enumNodiOperVariants.or]: "#f4d041",
    [enumNodiOperVariants.not]: "#f44184",
};

export class MetaNodiOperBuilding extends MetaBuilding {
    constructor() {
        super("nodi_oper");
    }

    getSilhouetteColor() {
        return "#ff5500";
    }

    /**
     * @param {GameRoot} root
     */
    getIsUnlocked(root) {
        return root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_logic_gates);
    }

    getAvailableVariants() {
        return [
            defaultBuildingVariant,
            enumNodiOperVariants.or,
            enumNodiOperVariants.not,
            enumNodiOperVariants.xor,
        ];
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
                        type: enumPinSlotType.logicalAcceptor
                    },
                ],
            })
        );
        entity.addComponent(new NodiOperComponent(entity));
    }
}
