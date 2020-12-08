import { HUDBaseToolbar } from "./base_toolbar";
import { MetaWireBuilding } from "../../buildings/wire";
import { MetaConstantSignalBuilding } from "../../buildings/constant_signal";
import { MetaLogicGateBuilding } from "../../buildings/logic_gate";
import { MetaNodiButtonBuilding } from "../../buildings/nodi_button";
import { MetaWireTunnelBuilding } from "../../buildings/wire_tunnel";
import { MetaVirtualProcessorBuilding } from "../../buildings/virtual_processor";
import { MetaTransistorBuilding } from "../../buildings/transistor";
import { MetaAnalyzerBuilding } from "../../buildings/analyzer";
import { MetaComparatorBuilding } from "../../buildings/comparator";
import { MetaReaderBuilding } from "../../buildings/reader";
import { MetaFilterBuilding } from "../../buildings/filter";
import { MetaNodiBlueBuilding } from "../../buildings/nodi_blue";
import { MetaStorageBuilding } from "../../buildings/storage";
import { MetaNodiLedBuilding } from "../../buildings/nodi_led";

export class HUDWiresToolbar extends HUDBaseToolbar {
    constructor(root) {
        super(root, {
            primaryBuildings: [
                MetaNodiButtonBuilding,
                MetaNodiLedBuilding,
                MetaConstantSignalBuilding,
                MetaLogicGateBuilding,
                MetaVirtualProcessorBuilding,
                MetaAnalyzerBuilding,
                MetaComparatorBuilding,
                MetaTransistorBuilding,
            ],
            secondaryBuildings: [
                MetaStorageBuilding,
                MetaReaderBuilding,
                MetaNodiButtonBuilding,
                MetaFilterBuilding,
                MetaNodiBlueBuilding,
            ],
            visibilityCondition: () =>
                !this.root.camera.getIsMapOverlayActive() && this.root.currentLayer === "wires",
            htmlElementId: "ingame_HUD_wires_toolbar",
            layer: "wires",
        });
    }
}
