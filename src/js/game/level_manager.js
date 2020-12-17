import { gMetaBuildingRegistry } from "../core/global_registries";
import { Vector } from "../core/vector";
import { defaultBuildingVariant } from "./meta_building";
import { MetaNodiButtonBuilding } from "./buildings/nodi_button";
import { MetaNodiLedBuilding } from "./buildings/nodi_led";
import { NodiLedComponent } from "./components/nodi_led";
import { GameRoot } from "./root";
import { enumNodiOperVariants, MetaNodiOperBuilding } from "./buildings/nodi_oper";
import { MetaNodiDataBuilding } from "./buildings/nodi_data";

export class LevelManager {
    /**
     * @param {GameRoot} root
     */
    constructor(root) {
        this.root = root;
    }

    addEntity(className, x, y, val, val2, buildingVariant) {
        let newEntity;
        if (className == MetaNodiOperBuilding) {
            newEntity = gMetaBuildingRegistry.findByClass(className).createEntity({
                root: this.root,
                origin: new Vector(x, y),
                variant: buildingVariant,
            });
        } else {
            newEntity = gMetaBuildingRegistry.findByClass(className).createEntity({
                root: this.root,
                origin: new Vector(x, y),
            });
        }

        if (newEntity.components.NodiButton) {
            newEntity.components.NodiButton.storedCount = val;
            if (buildingVariant) newEntity.components.NodiButton.toggled = buildingVariant;
        } else if (newEntity.components.NodiLed) {
            newEntity.components.NodiLed.allowedValue = val;
            newEntity.components.NodiLed.initialValue = val;
            if (val2) newEntity.components.NodiLed.storedCount = val2;
            if (buildingVariant) {
                newEntity.components.NodiLed.toggled = buildingVariant;
                newEntity.components.NodiLed.initialToggled = buildingVariant;
            }
        } else if (newEntity.components.NodiOper) {
            newEntity.components.NodiOper.isRemovable = false;
        }
        this.root.map.placeStaticEntity(newEntity);
        this.root.entityMgr.registerEntity(newEntity);
    }

    /**
     * add wall tile
     */
    addWall(x, y) {
        const that = this;
        if (Array.isArray(x)) {
            x.forEach(function (value) {
                that.addWall(value, y);
            });
        } else if (Array.isArray(y)) {
            y.forEach(function (value) {
                that.addWall(x, value);
            });
        } else {
            const newEntity = gMetaBuildingRegistry.findByClass(MetaNodiOperBuilding).createEntity({
                root: this.root,
                origin: new Vector(x, y),
            });

            this.root.map.placeStaticEntity(newEntity);
            this.root.entityMgr.registerEntity(newEntity);
        }
    }

    /**
     * Creates the next goal
     */
    setupLevel(level) {
        if (level == 1) {
            // main > 1
            this.addEntity(MetaNodiOperBuilding, -4, 0, 1, 0, enumNodiOperVariants.starter);
            this.addEntity(MetaNodiLedBuilding, 4, 0, 1);
        } else if (level == 2) {
            // a = 1
            this.addEntity(MetaNodiOperBuilding, -4, 0, 1, 0, enumNodiOperVariants.starter);
            this.addEntity(MetaNodiOperBuilding, 4, -2, 1, 0, enumNodiOperVariants.starter);
            this.addEntity(MetaNodiLedBuilding, -3, 4, 1);
            this.addEntity(MetaNodiLedBuilding, 1, 2, 1);
        } else if (level == 3) {
            // a=7; main=12;
            this.addEntity(MetaNodiOperBuilding, -4, 0, 1, 0, enumNodiOperVariants.starter);
            this.addEntity(MetaNodiButtonBuilding, -3, 4, 7);
            this.addEntity(MetaNodiLedBuilding, 4, -2, 7);
            this.addEntity(MetaNodiLedBuilding, 4, 2, 1);
        } else if (level == 4) {
            // a = b
            this.addEntity(MetaNodiLedBuilding, -4, 0, 12, 12);
            this.addEntity(MetaNodiButtonBuilding, 6, 0, 1);
            this.addEntity(MetaNodiLedBuilding, 2, 2, 12, 12, true);
        } else if (level == 5) {
            // 5 + 7 = 12
            this.addEntity(MetaNodiLedBuilding, 3, 3, 12, 12);
            this.addEntity(MetaNodiButtonBuilding, -5, 3, 5);
            this.addEntity(MetaNodiLedBuilding, 0, 0, 7, 7, true);
        } else if (level == 6) {
            // ((1+1)+2)+4) = 8
            this.addEntity(MetaNodiLedBuilding, 3, 0, 2, 2);
            this.addEntity(MetaNodiLedBuilding, -1, 0, 4, 4);
            this.addEntity(MetaNodiLedBuilding, -5, 0, 8, 8);
            this.addEntity(MetaNodiLedBuilding, -10, 0, 16, 16);
            this.addEntity(MetaNodiButtonBuilding, 5, -3, 2);
        } else if (level == 7) {
            // 2*3 + 5 = 11
            this.addEntity(MetaNodiButtonBuilding, -6, 1, 1);
            this.addEntity(MetaNodiLedBuilding, 2, 3, 5, 5, true);
            this.addEntity(MetaNodiLedBuilding, -4, -2, 3, 3, true);
            this.addEntity(MetaNodiLedBuilding, 0, -2, 2, 2, true);
            this.addEntity(MetaNodiLedBuilding, 4, -2, 11, 11);
        } else if (level == 8) {
            // 1+1+1+1+1+1 = 6  or  3+3=6
            this.addEntity(MetaNodiButtonBuilding, -5, 1, 1);
            this.addEntity(MetaNodiLedBuilding, 0, -2, 3, 3, true);
            this.addEntity(MetaNodiLedBuilding, 4, -2, 6, 6);
        } else if (level == 9) {
            // 2*2*2*2*2*2 = 64
            this.addEntity(MetaNodiButtonBuilding, -5, 1, 2);
            this.addEntity(MetaNodiLedBuilding, 0, -2, 2, 2, true);
            this.addEntity(MetaNodiLedBuilding, 4, -2, 64, 64);
        } else if (level == 10) {
            // if(a==5) b= 5
            this.addEntity(MetaNodiButtonBuilding, -6, 0, 5, 0);
            this.addEntity(MetaNodiLedBuilding, 0, 0, 5, 5, true);
            this.addEntity(MetaNodiLedBuilding, 6, 0, 5, 5);

            this.addWall([-8, -7, -6, -5, -4, -3, -2, -1, 0], -2);
            this.addWall(-8, [-1, 0, 1]);
            this.addWall([0, 1], 1);
            this.addWall([0, 1], -1);
            this.addWall([-8, -7, -6, -5, -4, -3, -2, -1, 0], 2);
        } else if (level == 11) {
            // if(a>5) b= a else c = a
            this.addEntity(MetaNodiButtonBuilding, -6, -1, 7, 0);
            this.addEntity(MetaNodiButtonBuilding, -6, 1, 3, 0);
            this.addEntity(MetaNodiLedBuilding, 0, 0, 5, 5, true);
            this.addEntity(MetaNodiLedBuilding, 6, -1, 7, 7);
            this.addEntity(MetaNodiLedBuilding, 6, 1, 3, 3);

            this.addWall([-8, -7, -6, -5, -4, -3, -2, -1, 0], -3);
            this.addWall(-8, [-2, -1, 0, 1, 2]);
            this.addWall([-8, -7, -6, -5, -4, -3, -2, -1, 0], 3);
            this.addWall(0, [-2, -1, 1, 2]);
        } else if (level == 12) {
            // 0-1-1-1-1-1=-5
            this.addEntity(MetaNodiButtonBuilding, -2, -2, 1, 0);
            this.addEntity(MetaNodiLedBuilding, -2, 2, 0, 0, true);
            this.addEntity(MetaNodiLedBuilding, 3, 2, -5, -5, false);
        } else if (level == 13) {
            // Main > 3+1+1+1 = 6
            this.addEntity(MetaNodiOperBuilding, -1, -2, 1, 0, enumNodiOperVariants.starter);
            this.addEntity(MetaNodiLedBuilding, -3, 2, 1, 1, true);
            this.addEntity(MetaNodiLedBuilding, 4, 0, 1, 1, true);
            this.addEntity(MetaNodiLedBuilding, 7, 0, 10, 10);
        } else if (level == 14) {
            // Main > -5 * -5 =25
            this.addEntity(MetaNodiOperBuilding, -1, -2, 1, 0, enumNodiOperVariants.starter);
            this.addEntity(MetaNodiLedBuilding, -3, 2, -5, -5, true);
            this.addEntity(MetaNodiLedBuilding, 7, 0, 25, 25);
            this.addEntity(MetaNodiLedBuilding, 2, 2, 15, 15, true);
        }
    }
}
