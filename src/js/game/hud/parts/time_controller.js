import { makeDiv } from "../../../core/utils";
import { BaseHUDPart } from "../base_hud_part";
import { DynamicDomAttach } from "../dynamic_dom_attach";
import { enumHubGoalRewards } from "../../tutorial_goals";
import { enumNotificationType } from "./notifications";

export class HUDTimeController extends BaseHUDPart {
    createElements(parent) {
        this.element = makeDiv(
            parent,
            "ingame_HUD_DebuggerController",
            [],
            `
            <label>Debugger (F7)</label>

            <div class="buttons">
                <button class="styledButton nodiRestart"></button>
                <button class="styledButton nodiRunStop nodiRun"></button>
            </div>
            <label class="tickLabel">Cycles: 0</label><br>
            <div class = "debugSlider">
                <label>Speed: </label> <input class="rangeInput" type="range" value="1900" min="0" max="2000" step="1">
            </div>
        `
        );

        const bind = (selector, handler) => this.trackClicks(this.element.querySelector(selector), handler);

        bind(".nodiRunStop", () => this.modifyLevel(-1));
        bind(".nodiRestart", () => this.restartNodiTick());

        this.getRangeInputElement().addEventListener("input", () => {this.setSpeed(); });
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
    
    showNodiTick(tickCount)  {
      this.element.querySelector("label.tickLabel").innerHTML = "Cycles: " + tickCount;
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
        this.root.nodiSolver.noditick = 0;
        //this.element.querySelector("button.playstop").innerHTML = ">>";
        this.showNodiTick(this.root.nodiSolver.noditick);
    }

    setSpeed() {
        let slider= Number(this.getRangeInputElement().value);
        if(slider == 0) 
            this.root.tickrate = 0;
        else
            this.root.tickrate = 2001 - Number(this.getRangeInputElement().value);
    }


    modifyLevel(amount) {
        let buttonElement = this.element.querySelector("button.nodiRunStop");
        if(this.root.nodistate == 0)
        {
          this.root.nodistate = 1;
          buttonElement.classList.remove("nodiRun");
          buttonElement.classList.add("nodiStop");
        }
        else
        {
          this.root.nodistate = 0;
          buttonElement.classList.add("nodiRun");
          buttonElement.classList.remove("nodiStop");
        }
    }

    initialize() {
        // Allow toggling the controller overlay
        this.root.gameState.inputReciever.keydown.add(key => {
            if (key.keyCode === 118 /*&& this.root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_wires_painter_and_levers)*/) {
                // F7
                this.toggle();
            }
        });

        this.visible = true; //this.root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_wires_painter_and_levers);
        this.domAttach = new DynamicDomAttach(this.root, this.element);
        this.element.querySelector("div.debugSlider").setAttribute("style", "display:none");
    }

    toggle() {
        this.visible = !this.visible;
    }

    update() {
        this.domAttach.update(this.visible);
    }
}
