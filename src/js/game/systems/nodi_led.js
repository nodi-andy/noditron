import { GameSystemWithFilter } from "../game_system_with_filter";
import { BOOL_TRUE_SINGLETON, BOOL_FALSE_SINGLETON } from "../items/boolean_item";
import { MapChunkView } from "../map_chunk_view";
import { globalConfig } from "../../core/config";
import { Loader } from "../../core/loader";
import { NodiLedComponent } from "../components/nodi_led";
import { formatBigNumber } from "../../core/utils";

export class NodiLedSystem extends GameSystemWithFilter {
    constructor(root) {
        super(root, [NodiLedComponent]);

        this.spriteOn = Loader.getSprite("sprites/wires/led_on.png");
        this.spriteOff = Loader.getSprite("sprites/buildings/nodi_led.png");
    }

    update() {
/*        for (let i = 0; i < this.allEntities.length; ++i) {
            const entity = this.allEntities[i];

            const buttonComp = entity.components.NodiLed;
            const pinsComp = entity.components.WiredPins;

            // Simply sync the status to the first slot
            pinsComp.slots[0].value = buttonComp.toggled ? BOOL_TRUE_SINGLETON : BOOL_FALSE_SINGLETON;
        }*/
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
            const ledComp = entity.components.NodiLed;
            if (ledComp) {
                const sprite = ledComp.toggled ? this.spriteOn : this.spriteOff;
                entity.components.StaticMapEntity.drawSpriteOnBoundsClipped(parameters, sprite);
                
                const staticComp = entity.components.StaticMapEntity;

                const center = staticComp.getTileSpaceBounds().getCenter().toWorldSpace();
                const context = parameters.context;
                if (parameters.visibleRect.containsCircle(center.x, center.y, 20)) {
                    context.font = "bold 12px GameFont";
                    context.textAlign = "center";
                    context.textBaseline = "middle";
                    context.fillStyle = "#64666e";
                    context.fillText(formatBigNumber(ledComp.allowedValue), center.x, center.y);
                    context.textAlign = "left";
                }
            }
        }
    }
}
