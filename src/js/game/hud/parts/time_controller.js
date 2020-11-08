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
                    <button class="styledButton play">|></button>
                    <button class="styledButton stop">||</button>
                    <button class="styledButton restart"><|</button>
                </div>
                <label>Tick: </label> <label class="tickLabel">0</label><br>
                <label>Speed: </label> <input class="rangeInput" type="range" value="1" min="0" max="2000" step="1">
            </div>
        `
        );

        const bind = (selector, handler) => this.trackClicks(this.element.querySelector(selector), handler);

        bind(".levelToggle .play", () => this.modifyLevel(-1));
        bind(".levelToggle .stop", () => this.modifyLevel(0));
        bind(".levelToggle .restart", () => this.restartNodiTick());

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
    
    showNodiTick(tickCount)
    {
      this.element.querySelector("label.tickLabel").innerHTML = tickCount;
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

    restartNodiTick() {
        this.root.tickrate = 0;
        this.root.nodiSolver.noditick = 0;
        this.showNodiTick(this.root.nodiSolver.noditick);
    }

    modifyLevel(amount) {
        if(amount == -1)
        {
            let slider= Number(this.getRangeInputElement().value);
            if(slider == 0) 
               this.root.tickrate = 0;
            else
              this.root.tickrate = 2001 - Number(this.getRangeInputElement().value);
        }
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
