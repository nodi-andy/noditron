import { MetaBeltBuilding } from "../../buildings/belt";
import { MetaCondBuilding } from "../../buildings/cond";
import { MetaCutterBuilding } from "../../buildings/cutter";
import { MetaNodiBlueBuilding } from "../../buildings/nodi_blue";
import { MetaNodiRedBuilding } from "../../buildings/nodi_red";
import { MetaNodiLedBuilding } from "../../buildings/nodi_led";
import { MetaNodiBlueDiscusBuilding } from "../../buildings/nodi_blue_discus";
import { MetaNodiOperBuilding } from "../../buildings/nodi_oper";
import { MetaNodiDataBuilding } from "../../buildings/nodi_data";
import { MetaFilterBuilding } from "../../buildings/filter";
import { MetaNodiButtonBuilding } from "../../buildings/nodi_button";
import { MetaMinerBuilding } from "../../buildings/miner";
import { MetaMixerBuilding } from "../../buildings/mixer";
import { MetaPainterBuilding } from "../../buildings/painter";
import { MetaReaderBuilding } from "../../buildings/reader";
import { MetaRotaterBuilding } from "../../buildings/rotater";
import { MetaBalancerBuilding } from "../../buildings/balancer";
import { MetaStackerBuilding } from "../../buildings/stacker";
import { MetaTrashBuilding } from "../../buildings/trash";
import { MetaUndergroundBeltBuilding } from "../../buildings/underground_belt";
import { HUDBaseToolbar } from "./base_toolbar";
import { MetaStorageBuilding } from "../../buildings/storage";
import { MetaItemProducerBuilding } from "../../buildings/item_producer";
import { queryParamOptions } from "../../../core/query_parameters";

export class HUDBuildingsToolbar extends HUDBaseToolbar {
    constructor(root) {
        super(root, {
            primaryBuildings: [
                MetaNodiRedBuilding,
                MetaNodiRedBuilding,
                MetaNodiOperBuilding,
//               ...(queryParamOptions.sandboxMode || G_IS_DEV ? [MetaItemProducerBuilding] : []),
            ],
            secondaryBuildings: [
                MetaNodiBlueBuilding,
                MetaNodiBlueDiscusBuilding,
                MetaNodiDataBuilding,
            ],
            visibilityCondition: () =>
                !this.root.camera.getIsMapOverlayActive() && this.root.currentLayer === "regular",
            htmlElementId: "ingame_HUD_BuildingsToolbar",
        });
    }
}
