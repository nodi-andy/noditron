import { MetaBeltBuilding } from "../../buildings/belt";
import { MetaCondBuilding } from "../../buildings/cond";
import { MetaCutterBuilding } from "../../buildings/cutter";
import { MetaNodiBlueBuilding } from "../../buildings/nodi_blue";
import { MetaDisplayRedBuilding } from "../../buildings/display_red";
import { MetaNodiLedBuilding } from "../../buildings/nodi_led";
import { MetaNodiDiscusBuilding } from "../../buildings/nodi_discus";
import { MetaNodiOperBuilding } from "../../buildings/nodi_oper";
import { MetaNodiDataBuilding } from "../../buildings/nodi_data";
import { MetaFilterBuilding } from "../../buildings/filter";
import { MetaLeverBuilding } from "../../buildings/lever";
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
                MetaNodiBlueBuilding,
                MetaNodiDiscusBuilding,
                MetaNodiDataBuilding,
                MetaNodiOperBuilding,
//                MetaUndergroundBeltBuilding,
//                MetaMinerBuilding,
//                MetaCutterBuilding,
//                MetaRotaterBuilding,
//                MetaStackerBuilding,
//                MetaMixerBuilding,
//                MetaPainterBuilding,
//                MetaTrashBuilding,
//               ...(queryParamOptions.sandboxMode || G_IS_DEV ? [MetaItemProducerBuilding] : []),
            ],
            secondaryBuildings: [
                MetaStorageBuilding,
                MetaReaderBuilding,
                MetaLeverBuilding,
                MetaFilterBuilding,
            ],
            visibilityCondition: () =>
                !this.root.camera.getIsMapOverlayActive() && this.root.currentLayer === "regular",
            htmlElementId: "ingame_HUD_BuildingsToolbar",
        });
    }
}
