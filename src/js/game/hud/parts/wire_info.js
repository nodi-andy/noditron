import { globalConfig } from "../../../core/config";
import { MapChunkView } from "../../map_chunk_view";
import { WireNetwork } from "../../systems/wire";
import { THEME } from "../../theme";
import { BaseHUDPart } from "../base_hud_part";
import { Loader } from "../../../core/loader";
import { NodiBlueDiscusComponent } from "../../components/nodi_blue_discus";
import { MetaNodiBlueDiscusBuilding } from "../../buildings/nodi_blue_discus";

export class HUDWireInfo extends BaseHUDPart {
    initialize() {
        this.spriteEmpty = Loader.getSprite("sprites/wires/network_empty.png");
        this.spriteConflict = Loader.getSprite("sprites/wires/network_conflict.png");
        this.root.hud.signals.selectedPlacementBuildingChanged.add(
            this.selectedPlacementBuildingChanged,
            this
        );
        this.currentBuilding = undefined;
    }

    selectedPlacementBuildingChanged(metaBuilding) {
        this.currentBuilding = metaBuilding;
    }

    /**
     *
     * @param {import("../../../core/draw_utils").DrawParameters} parameters
     */
    drawOverlays(parameters) {
        if (this.root.currentLayer !== "wires") {
            // Not in the wires layer
            //return;
        }

        const mousePos = this.root.app.mousePosition;
        if (!mousePos) {
            // No mouse
            return;
        }

        if (this.currentBuilding && this.currentBuilding.id == "nodi_blue_discus") {
            const worldPos = this.root.camera.screenToWorld(mousePos);
            const tile = worldPos.toTileSpace();
            parameters.context.textAlign = "left";
            parameters.context.textBaseline = "middle";
            parameters.context.fillStyle = "#000000";
            parameters.context.font = "25px Arial";
            if (this.root.map.getLayerContentXY(tile.x + 1, tile.y + 1, "wires")) {
                parameters.context.fillText("- (subtract)", mousePos.x + 12, mousePos.y);
            } else if (this.root.map.getLayerContentXY(tile.x + 1, tile.y - 1, "wires")) {
                parameters.context.fillText("+ (add)", mousePos.x + 12, mousePos.y);
            } else if (this.root.map.getLayerContentXY(tile.x + 1, tile.y, "wires")) {
                parameters.context.fillText("== (compare)", mousePos.x + 12, mousePos.y);
            } else if (this.root.map.getLayerContentXY(tile.x - 1, tile.y, "wires")) {
                parameters.context.fillText("?= (is equal)", mousePos.x + 12, mousePos.y);
                parameters.context.fillText("% (modulus)", mousePos.x + 12, mousePos.y+25);
            } else if (this.root.map.getLayerContentXY(tile.x - 1, tile.y - 1, "wires")) {
                parameters.context.fillText("* (multiplicate)", mousePos.x + 12, mousePos.y);
            } else if (this.root.map.getLayerContentXY(tile.x, tile.y - 1, "wires")) {
                parameters.context.fillText("Read", mousePos.x + 12, mousePos.y);
            } else if (this.root.map.getLayerContentXY(tile.x, tile.y + 1, "wires")) {
                parameters.context.fillText("Write", mousePos.x + 12, mousePos.y);
            }
        }
        /*
        if (!entity) {
            // No entity
            return;
        }

        if (
            !this.root.camera.getIsMapOverlayActive() &&
            !this.root.logic.getIsEntityIntersectedWithMatrix(entity, worldPos)
        ) {
            // Detailed intersection check
            return;
        }

        const networks = this.root.logic.getEntityWireNetworks(entity, tile);
        if (networks === null) {
            // This entity will never be able to be connected
            return;
        }

        if (networks.length === 0) {
            // No network at all
            return;
        }

        for (let i = 0; i < networks.length; ++i) {
            const network = networks[i];
            this.drawHighlightedNetwork(parameters, network);
        }

        if (networks.length === 1) {
            const network = networks[0];

            if (network.valueConflict) {
                this.spriteConflict.draw(parameters.context, mousePos.x + 15, mousePos.y - 10, 60, 60);
            } else if (!network.currentValue) {
                this.spriteEmpty.draw(parameters.context, mousePos.x + 15, mousePos.y - 10, 60, 60);
            } else {
                network.currentValue.drawItemCenteredClipped(
                    mousePos.x + 40,
                    mousePos.y + 10,
                    parameters,
                    60
                );
            }
        }*/
    }

    /**
     *
     *
     * @param {import("../../../core/draw_utils").DrawParameters} parameters
     * @param {WireNetwork} network
     */
    drawHighlightedNetwork(parameters, network) {
        /* parameters.context.globalAlpha = 0.5;

        for (let i = 0; i < network.wires.length; ++i) {
            const wire = network.wires[i];
            const staticComp = wire.components.StaticMapEntity;
            const screenTile = this.root.camera.worldToScreen(staticComp.origin.toWorldSpace());
            MapChunkView.drawSingleWiresOverviewTile({
                context: parameters.context,
                x: screenTile.x,
                y: screenTile.y,
                entity: wire,
                tileSizePixels: globalConfig.tileSize * this.root.camera.zoomLevel,
                overrideColor: THEME.map.wires.highlightColor,
            });
        }

        for (let i = 0; i < network.tunnels.length; ++i) {
            const tunnel = network.tunnels[i];
            const staticComp = tunnel.components.StaticMapEntity;
            const screenTile = this.root.camera.worldToScreen(staticComp.origin.toWorldSpace());
            MapChunkView.drawSingleWiresOverviewTile({
                context: parameters.context,
                x: screenTile.x,
                y: screenTile.y,
                entity: tunnel,
                tileSizePixels: globalConfig.tileSize * this.root.camera.zoomLevel,
                overrideColor: THEME.map.wires.highlightColor,
            });
        }
        parameters.context.globalAlpha = 1;*/
    }
}
