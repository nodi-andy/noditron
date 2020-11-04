import { globalConfig } from "../../core/config";
import { Loader } from "../../core/loader";
import { BaseItem } from "../base_item";
import { enumColors } from "../colors";
import { DisplayComponent } from "../components/display";
import { GameSystemWithFilter } from "../game_system_with_filter";
import { isTrueItem } from "../items/boolean_item";
import { ColorItem, COLOR_ITEM_SINGLETONS } from "../items/color_item";
import { MapChunkView } from "../map_chunk_view";
import { formatBigNumber, lerp } from "../../core/utils";

export class DisplaySystem extends GameSystemWithFilter {
    constructor(root) {
        super(root, [DisplayComponent]);

        /** @type {Object<string, import("../../core/draw_utils").AtlasSprite>} */
        this.displaySprites = {};

        for (const colorId in enumColors) {
            if (colorId === enumColors.uncolored) {
                continue;
            }
            this.displaySprites[colorId] = Loader.getSprite("sprites/wires/display/" + colorId + ".png");
        }
    }

    /**
     * Returns the color / value a display should show
     * @param {BaseItem} value
     * @returns {BaseItem}
     */
    getDisplayItem(value) {
        if (!value) {
            return null;
        }

        switch (value.getItemType()) {
            case "boolean": {
                return isTrueItem(value) ? COLOR_ITEM_SINGLETONS[enumColors.white] : null;
            }

            case "color": {
                const item = /**@type {ColorItem} */ (value);
                return item.color === enumColors.uncolored ? null : item;
            }

            case "shape": {
                return value;
            }

            default:
                assertAlways(false, "Unknown item type: " + value.getItemType());
        }
    }

    /**
     * Draws a given chunk
     * @param {import("../../core/draw_utils").DrawParameters} parameters
     * @param {MapChunkView} chunk
     */
    drawChunk(parameters, chunk) {
        const contents = chunk.containedEntitiesByLayer.regular;
        for (let i = 0; i < contents.length; ++i) {
            const entity = contents[i];
            if (entity && entity.components.Display) {
                const pinsComp = entity.components.WiredPins;
                const network = pinsComp.slots[0].linkedNetwork;

                const origin = entity.components.StaticMapEntity.origin;
                let size = globalConfig.tileSize;
                if (pinsComp.slots[0].nodiType==10) size*=0.75;
                
                    this.displaySprites[enumColors.white].drawCachedCentered(
                        parameters,
                        (origin.x + 0.5) * globalConfig.tileSize,
                        (origin.y + 0.5) * globalConfig.tileSize,
                        size
                    );

                const dispComp = entity.components.Display;
                const staticComp = entity.components.StaticMapEntity;

                const contentsNB = this.root.map.getLayerContentXY(staticComp.origin.x+1, staticComp.origin.y, "regular");
                if (contentsNB) {
                  const dispCompNB = contentsNB.components.Display;
                  if (dispCompNB && pinsComp.slots[0].nodiType == 10) {
                    contentsNB.components.WiredPins.slots[0].nodiType = 10;
                    contentsNB.components.WiredPins.slots[0].nodiVal = pinsComp.slots[0].nodiVal;
                    pinsComp.slots[0].nodiType = 2;
                  }
                }

                const center = staticComp.getTileSpaceBounds().getCenter().toWorldSpace();
                const context = parameters.context;
                if (parameters.visibleRect.containsCircle(center.x, center.y + 25, 20) && pinsComp.slots[0].nodiType==10) {
                    context.font = "bold 10px GameFont";
                    context.textAlign = "center";
                    context.fillStyle = "#64666e";
                    context.fillText(formatBigNumber(pinsComp.slots[0].nodiVal), center.x, center.y);
                    context.textAlign = "left";
                }
            }
        }
    }
}
