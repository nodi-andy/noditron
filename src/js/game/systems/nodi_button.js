import { GameSystemWithFilter } from "../game_system_with_filter";
import { NodiButtonComponent } from "../components/nodi_button";
import { BOOL_TRUE_SINGLETON, BOOL_FALSE_SINGLETON } from "../items/boolean_item";
import { MapChunkView } from "../map_chunk_view";
import { globalConfig } from "../../core/config";
import { Loader } from "../../core/loader";
import { formatBigNumber } from "../../core/utils";

export class NodiButtonSystem extends GameSystemWithFilter {
    constructor(root) {
        super(root, [NodiButtonComponent]);

        this.spriteOn = Loader.getSprite("sprites/wires/nodi_button_on.png");
        this.spriteOff = Loader.getSprite("sprites/buildings/nodi_button.png");
    }

    update() {
        for (let i = 0; i < this.allEntities.length; ++i) {
            const entity = this.allEntities[i];

            const buttonComp = entity.components.nodi_button;
            const pinsComp = entity.components.WiredPins;

            // Simply sync the status to the first slot
            pinsComp.slots[0].value = buttonComp.toggled ? BOOL_TRUE_SINGLETON : BOOL_FALSE_SINGLETON;
        }
    }

    /**
     * Draws a given chunk
     * @param {import("../../core/draw_utils").DrawParameters} parameters
     * @param {MapChunkView} chunk
     */
    drawChunk(parameters, chunk) {
        const contents = chunk.containedEntitiesByLayer.wires;
        for (let i = 0; i < contents.length; ++i) {
            const entity = contents[i];
            const buttonComp = entity.components.nodi_button;
            if (buttonComp) {
                let sprite;
                if(buttonComp.toggled) 
                    sprite = this.spriteOn; 
                else
                    sprite = this.spriteOff;
                const staticComp = entity.components.StaticMapEntity;
                staticComp.drawSpriteOnBoundsClipped(parameters, sprite);

                const center = staticComp.getTileSpaceBounds().getCenter().toWorldSpace();
                const context = parameters.context;
                if (parameters.visibleRect.containsCircle(center.x, center.y, 20)) {
                    context.font = "bold 12px GameFont";
                    context.textAlign = "center";
                    context.textBaseline = "middle";
                    context.fillStyle = "#64666e";
                    context.fillText(formatBigNumber(buttonComp.storedCount), center.x, center.y);
                }
            }
        }
    }
}
