import { GameSystemWithFilter } from "../game_system_with_filter";
import { BOOL_TRUE_SINGLETON, BOOL_FALSE_SINGLETON } from "../items/boolean_item";
import { MapChunkView } from "../map_chunk_view";
import { globalConfig } from "../../core/config";
import { Loader } from "../../core/loader";
import { NodiRedDiscusComponent } from "../components/nodi_red_discus";
import { formatBigNumber } from "../../core/utils";

export class NodiRedDiscusSystem extends GameSystemWithFilter {
    constructor(root) {
        super(root, [NodiRedDiscusComponent]);
    }

    update() {
        for (let i = 0; i < this.allEntities.length; ++i) {
            const entity = this.allEntities[i];

            const buttonComp = entity.components.NodiLed;
            const pinsComp = entity.components.WiredPins;

            // Simply sync the status to the first slot
            //pinsComp.slots[0].value = buttonComp.toggled ? BOOL_TRUE_SINGLETON : BOOL_FALSE_SINGLETON;
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
            const comp = entity.components.NodiBlueDiscus;
            if (comp) {
                const staticComp = entity.components.StaticMapEntity;
                const center = staticComp.getTileSpaceBounds().getCenter().toWorldSpace();
                const context = parameters.context;
                if (parameters.visibleRect.containsCircle(center.x, center.y, 20)  &&  comp.storedType == 14) {
                    context.font = "bold 14px GameFont";
                    context.textAlign = "center";
                    context.textBaseline = "middle";
                    context.fillStyle = "#64666e";
                    context.fillText(formatBigNumber(comp.storedCount), center.x, center.y);
                    context.textAlign = "left";
                }
            }
        }
    }
}
