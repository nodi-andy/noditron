import { NodiComponent } from "../nodi_component";
import { enumNodiTypes, enumNodiBits } from "../nodisolver";


export class NodiOperComponent extends NodiComponent {

    static getId() {
        return "NodiOper";
    }

    /**

     */
    constructor(entityFromSystem) {
        super();
        this.storedType = 3;
        this.storedTypeNext = 3;
        this.storedCount = 0;
        this.entity = entityFromSystem;
    }

    nodiProc(map){
        const staticComp = this.entity.components.StaticMapEntity;
        let inputArray = [];
        for (var i = 0; i < 8; i++) {
            var NB = this.getNB(i);
            let xt = staticComp.origin.x + NB[0];
            let yt = staticComp.origin.y + NB[1];
            let inputEntity = map.getLayerContentXY(xt, yt, "regular");
            if(inputEntity && inputEntity.components) 
            {
                let inputComp = undefined;
                if(inputComp == undefined) inputComp = inputEntity.components.NodiData;
                if(inputComp)
                {
                    inputArray.push(inputComp.storedCount);
                }
            }
        }
        let output = 0;
        if(this.storedCount == 1)
        {
            if(inputArray[0])
              output = 1;

            for (var i = 0; i < 8; i++) {
                var NB = this.getNB(i);
                let xt = staticComp.origin.x + NB[0];
                let yt = staticComp.origin.y + NB[1];
                this.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1], output);
            }
        }
        else if(this.storedCount == 2)
        {
            for (var i = 0; i < 8; i++) {
                var NB = this.getNB(i);
                let xt = staticComp.origin.x + NB[0];
                let yt = staticComp.origin.y + NB[1];
                this.ping(map, xt, yt, [enumNodiTypes.COND_1, enumNodiTypes.DISCUS_1], 1);
            }
        }



        this.clearNewtypeBit(enumNodiBits.TRAN);
        this.setNewtypeBit(enumNodiBits.PUSH);
    }
}
