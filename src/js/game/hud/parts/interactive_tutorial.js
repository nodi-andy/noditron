import { BaseHUDPart } from "../base_hud_part";
import { makeDiv } from "../../../core/utils";
import { GameRoot } from "../../root";
import { NodiBlueComponent } from "../../components/nodi_blue";
import { DynamicDomAttach } from "../dynamic_dom_attach";
import { TrackedState } from "../../../core/tracked_state";
import { cachebust } from "../../../core/cachebust";
import { T } from "../../../translations";
import { enumItemProcessorTypes, ItemProcessorComponent } from "../../components/item_processor";
import { ShapeItem } from "../../items/shape_item";
import { WireComponent } from "../../components/wire";
import { NodiButtonComponent } from "../../components/nodi_button";
import { NodiLedComponent } from "../../components/nodi_led";

// @todo: Make dictionary
const tutorialsByLevel = [
    // Level 1
    [
        // 1.1. place an extractor
        {
            id: "1_1_extractor",
            title: "1",
            /** @param {GameRoot} root */

            condition: root => root.entityMgr.getAllWithComponent(NodiBlueComponent).length <= 6,
        },
        // 1.2. connect to hub
        {
            id: "1_2_conveyor",
            title: "1",
            condition: /** @param {GameRoot} root */ root => root.hubGoals.getCurrentGoalDelivered() === 0,
        },
    ],
    [], // Level 2
    // Level 3
    [
        // 2.1 place a cutter
        {
            id: "2_1_place_cutter",
            title: "1",
            condition: /** @param {GameRoot} root */ root => root.hubGoals.getCurrentGoalDelivered() === 0,
        },
    ],

    // Level 3
    [
        // 3.1. rectangles
        {
            id: "3_1_rectangles",
            title: "1",
            condition: /** @param {GameRoot} root */ root =>
                // 4 miners placed above rectangles and 10 delivered
                root.hubGoals.getCurrentGoalDelivered() < 10 ||
                root.entityMgr.getAllWithComponent(NodiBlueComponent).filter(entity => {
                    const tile = entity.components.StaticMapEntity.origin;
                    const below = root.map.getLowerLayerContentXY(tile.x, tile.y);
                    if (below && below.getItemType() === "shape") {
                        const shape = /** @type {ShapeItem} */ (below).definition.getHash();
                        return shape === "RuRuRuRu";
                    }
                    return false;
                }).length < 4,
        },
    ],

    [], // Level 5
    [], // Level 6
    [], // Level 7
    [], // Level 8
    [], // Level 9
    [], // Level 10
    [], // Level 11
    [], // Level 12
    [], // Level 13
    [], // Level 14
    [], // Level 15
    [], // Level 16
    [], // Level 17
    [], // Level 18
    [], // Level 19
    [], // Level 20

    // Level 21
    [
        // 21.1 place quad painter
        {
            id: "21_1_place_quad_painter",
            title: "1",
            condition: /** @param {GameRoot} root */ root =>
                root.entityMgr
                    .getAllWithComponent(ItemProcessorComponent)
                    .filter(e => e.components.ItemProcessor.type === enumItemProcessorTypes.painterQuad)
                    .length === 0,
        },

        // 21.2 switch to wires layer
        {
            id: "21_2_switch_to_wires",
            title: "1",
            condition: /** @param {GameRoot} root */ root =>
                root.entityMgr.getAllWithComponent(WireComponent).length < 5,
        },

        // 21.3 place button
        {
            id: "21_3_place_button",
            title: "1",
            condition: /** @param {GameRoot} root */ root =>
                root.entityMgr.getAllWithComponent(NodiButtonComponent).length === 0,
        },

        // 21.4 activate button
        {
            id: "21_4_press_button",
            title: "1",
            condition: /** @param {GameRoot} root */ root =>
                root.entityMgr
                    .getAllWithComponent(NodiButtonComponent)
                    .some(e => !e.components.Lever.toggled),
        },
    ],
];

export class HUDInteractiveTutorial extends BaseHUDPart {
    createElements(parent) {
        this.element = makeDiv(parent, "ingame_HUD_InteractiveTutorial", ["animEven"]);
        this.elementTitle = makeDiv(this.element, null, ["title"]);
        this.elementDescription = makeDiv(this.element, null, ["desc"]);
        this.elementGif = makeDiv(this.element, null, ["helperGif"]);
    }

    initialize() {
        this.domAttach = new DynamicDomAttach(this.root, this.element, { trackHover: true });
        this.currentHintId = new TrackedState(this.onHintChanged, this);
        this.currentTitle = new TrackedState(this.onTitleChanged, this);
    }

    onHintChanged(hintId) {
        this.elementDescription.innerHTML = T.ingame.interactiveTutorial.hints[hintId];
        this.elementGif.style.backgroundImage =
            "url('" + cachebust("res/ui/interactive_tutorial.noinline/" + hintId + ".gif") + "')";
        this.element.classList.toggle("animEven");
        this.element.classList.toggle("animOdd");
    }

    onTitleChanged(titleId) {
        this.elementTitle.innerHTML = `<strong class="title">${T.ingame.interactiveTutorial.title[titleId]}</strong>`;
        this.element.classList.toggle("animEven");
        this.element.classList.toggle("animOdd");
        if (T.ingame.interactiveTutorial.title[titleId] == "Task") this.elementGif.remove();
    }

    update() {
        // Compute current hint
        const thisLevelHints = tutorialsByLevel[this.root.hubGoals.level - 1];
        let targetHintId = null;
        let targetTitleId = null;

        if (thisLevelHints) {
            for (let i = 0; i < thisLevelHints.length; ++i) {
                const hint = thisLevelHints[i];
                if (hint.condition(this.root)) {
                    targetHintId = hint.id;
                    targetTitleId = hint.title;
                    break;
                }
            }
        }

        this.currentHintId.set(targetHintId);
        this.currentTitle.set(targetTitleId);
        this.domAttach.update(!!targetHintId);
        this.domAttach.update(!!targetTitleId);
    }
}
