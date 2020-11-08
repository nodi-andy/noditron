import { STOP_PROPAGATION } from "../../../core/signal";
import { Vector } from "../../../core/vector";
import { enumMouseButton } from "../../camera";
import { BaseHUDPart } from "../base_hud_part";

import trim from "trim";
import { THIRDPARTY_URLS } from "../../../core/config";
import { DialogWithForm } from "../../../core/modal_dialog_elements";
import { FormElementInput, FormElementItemChooser } from "../../../core/modal_dialog_forms";
import { fillInLinkIntoTranslation } from "../../../core/utils";
import { T } from "../../../translations";
import { BaseItem } from "../../base_item";
import { enumColors } from "../../colors";
import { Entity } from "../../entity";
import { BOOL_FALSE_SINGLETON, BOOL_TRUE_SINGLETON } from "../../items/boolean_item";
import { COLOR_ITEM_SINGLETONS } from "../../items/color_item";
import { ShapeDefinition } from "../../shape_definition";
import { enumNotificationType } from "./notifications";

export class HUDDisplayToggle extends BaseHUDPart {
    initialize() {
        this.root.camera.downPreHandler.add(this.downPreHandler, this);
    }

    /**
     * @param {Vector} pos
     * @param {enumMouseButton} button
     */
    downPreHandler(pos, button) {
        const tile = this.root.camera.screenToWorld(pos).toTileSpace();
        const contents = this.root.map.getLayerContentXY(tile.x, tile.y, "regular");
        if (contents) {
            let dispComp = undefined;
            if(dispComp == undefined) dispComp = contents.components.Display;
            if(dispComp == undefined) dispComp = contents.components.DisplayRed;
            if(dispComp == undefined) dispComp = contents.components.NodiData;
            if (dispComp) {
                if (button === enumMouseButton.left) {
                   // contents.components.WiredPins.slots[0].nodiType = parseInt(window.prompt("Enter the memory value.", dispComp.storedCount));
                   
                    const entity = contents;

                    // Ok, query, but also save the uid because it could get stale
                    const uid = entity.uid;

                    const signalValueInput = new FormElementInput({
                        id: "signalValue",
                        label: fillInLinkIntoTranslation(T.dialogs.editSignal.descShortKey, THIRDPARTY_URLS.shapeViewer),
                        placeholder: "",
                        defaultValue: "",
                        validator: val => this.parseSignalCode(val),
                    });

                    const itemInput = new FormElementItemChooser({
                        id: "signalItem",
                        label: null,
                        items: [
                            BOOL_FALSE_SINGLETON,
                            BOOL_TRUE_SINGLETON,
                            ...Object.values(COLOR_ITEM_SINGLETONS),
                            this.root.shapeDefinitionMgr.getShapeItemFromDefinition(
                                this.root.hubGoals.currentGoal.definition
                            ),
                            this.root.shapeDefinitionMgr.getShapeItemFromShortKey(
                                this.root.gameMode.getBlueprintShapeKey()
                            ),
                            ...this.root.hud.parts.pinnedShapes.pinnedShapes.map(key =>
                                this.root.shapeDefinitionMgr.getShapeItemFromShortKey(key)
                            ),
                        ],
                    });

                    const dialog = new DialogWithForm({
                        app: this.root.app,
                        title: T.dialogs.editSignal.title,
                        desc: T.dialogs.editSignal.descItems,
                        formElements: [itemInput, signalValueInput],
                        buttons: ["cancel:bad:escape", "ok:good:enter"],
                        closeButton: false,
                    });
                    this.root.hud.parts.dialogs.internalShowDialog(dialog);

                    // When confirmed, set the signal
                    const closeHandler = () => {
                        if (!this.root || !this.root.entityMgr) {
                            // Game got stopped
                            return;
                        }

                        this.root.hud.signals.notification.dispatch(
                        "DIALOG " + signalValueInput.getValue() ,  enumNotificationType.upgrade  );

                        contents.components.WiredPins.slots[0].nodiVal= Number.parseInt(signalValueInput.getValue());
                        contents.components.WiredPins.slots[0].nodiType = 10;
                        dispComp.storedCount = Number.parseInt(signalValueInput.getValue());
                        dispComp.storedType = 10;
                    };

                    dialog.buttonSignals.ok.add(closeHandler);
                    dialog.valueChosen.add(closeHandler);

                    // When cancelled, destroy the entity again
                    dialog.buttonSignals.cancel.add(() => {
                        if (!this.root || !this.root.entityMgr) {
                            // Game got stopped
                            return;
                        }

                        const entityRef = this.root.entityMgr.findByUid(uid, false);
                        if (!entityRef) {
                            // outdated
                            return;
                        }

                        const constantComp = entityRef.components.ConstantSignal;
                        if (!constantComp) {
                            // no longer interesting
                            return;
                        }

                        this.root.logic.tryDeleteBuilding(entityRef);
                    });
                   return STOP_PROPAGATION;
                } else if (button === enumMouseButton.right) {
                    this.root.logic.tryDeleteBuilding(contents);
                    return STOP_PROPAGATION;
                }
               
            }

        }
    }
    /**
     * Tries to parse a signal code
     * @param {string} code
     * @returns {number}
     */
    parseSignalCode(code) {
        if (!this.root || !this.root.shapeDefinitionMgr) {
            // Stale reference
            return null;
        }

       return Number.parseInt(code);
    }
}
