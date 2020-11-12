import { types } from "../../savegame/serialization";
import { NodiComponent } from "../nodi_component";

export class NodiDataComponent extends NodiComponent {

    static getId() {
        return "NodiData";
    }
 
     getSilhouetteColor() {
        return "#11ff11";
    }
       /**

     */
    constructor(entityFromSystem) {
        super();
        this.storedType = 4;
        this.entity = entityFromSystem;
    }
    
    nodiProc(){
    }
}
