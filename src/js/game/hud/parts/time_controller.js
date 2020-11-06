import { makeDiv } from "../../../core/utils";
import { BaseHUDPart } from "../base_hud_part";
import { DynamicDomAttach } from "../dynamic_dom_attach";
import { enumNotificationType } from "./notifications";

export class HUDTimeController extends BaseHUDPart {
    createElements(parent) {
        this.element = makeDiv(
            parent,
            "ingame_HUD_SandboxController",
            [],
            `
            <label>Debugger (F7)</label>

            <div class="buttons">
                <div class="levelToggle plusMinus">
                    <label></label>
                    <button class="styledButton play"> > </button>
                    <button class="styledButton stop">||</button>
                </div>
                <div class="levelToggle additionalOptions">
                    <label>Speed: </label> <input class="rangeInput" type="range" value="1" min="0" max="2000" step="1">
                </div>
            </div>
        `
        );

        const bind = (selector, handler) => this.trackClicks(this.element.querySelector(selector), handler);

        bind(".levelToggle .play", () => this.modifyLevel(-1));
        bind(".levelToggle .stop", () => this.modifyLevel(0));

        this.getRangeInputElement().addEventListener("input", () => {this.modifyLevel(-1); });
    }

    /**
     * @returns {HTMLInputElement}
     */
    getRangeInputElement() {
        return this.element.querySelector("input.rangeInput");
    }

    giveBlueprints() {
        const shape = this.root.gameMode.getBlueprintShapeKey();
        if (!this.root.hubGoals.storedShapes[shape]) {
            this.root.hubGoals.storedShapes[shape] = 0;
        }
        this.root.hubGoals.storedShapes[shape] += 1e9;
    }

    maxOutAll() {
        this.modifyUpgrade("belt", 100);
        this.modifyUpgrade("miner", 100);
        this.modifyUpgrade("processors", 100);
        this.modifyUpgrade("painting", 100);
    }

    modifyUpgrade(id, amount) {
        const upgradeTiers = this.root.gameMode.getUpgrades()[id];
        const maxLevel = upgradeTiers.length;

        this.root.hubGoals.upgradeLevels[id] = Math.max(
            0,
            Math.min(maxLevel, (this.root.hubGoals.upgradeLevels[id] || 0) + amount)
        );

        // Compute improvement
        let improvement = 1;
        for (let i = 0; i < this.root.hubGoals.upgradeLevels[id]; ++i) {
            improvement += upgradeTiers[i].improvement;
        }
        this.root.hubGoals.upgradeImprovements[id] = improvement;
        this.root.signals.upgradePurchased.dispatch(id);
        this.root.hud.signals.notification.dispatch(
            "Upgrade '" + id + "' is now at tier " + (this.root.hubGoals.upgradeLevels[id] + 1),
            enumNotificationType.upgrade
        );
    }

    modifyLevel(amount) {
        if(amount == -1)
          this.root.tickrate = Number(this.getRangeInputElement().value);
        else
          this.root.tickrate = amount;
    }

    initialize() {
        // Allow toggling the controller overlay
        this.root.gameState.inputReciever.keydown.add(key => {
            if (key.keyCode === 118) {
                // F7
                this.toggle();
            }
        });

        this.visible = true;
        this.domAttach = new DynamicDomAttach(this.root, this.element);
    }

    toggle() {
        this.visible = !this.visible;
    }

    update() {
        this.domAttach.update(this.visible);
    }
}
