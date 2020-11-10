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
    constructor() {
        super();
        this.storedType = 4;
    }
    
    nodiProc(){
    }
}
