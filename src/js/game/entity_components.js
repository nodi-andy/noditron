/* typehints:start */
import { BeltComponent } from "./components/belt";
import { BeltUnderlaysComponent } from "./components/belt_underlays";
import { HubComponent } from "./components/hub";
import { ItemAcceptorComponent } from "./components/item_acceptor";
import { ItemEjectorComponent } from "./components/item_ejector";
import { ItemProcessorComponent } from "./components/item_processor";
import { MinerComponent } from "./components/miner";
import { StaticMapEntityComponent } from "./components/static_map_entity";
import { StorageComponent } from "./components/storage";
import { UndergroundBeltComponent } from "./components/underground_belt";
import { WiredPinsComponent } from "./components/wired_pins";
import { WireComponent } from "./components/wire";
import { ConstantSignalComponent } from "./components/constant_signal";
import { LogicGateComponent } from "./components/logic_gate";
import { NodiButtonComponent } from "./components/nodi_button";
import { WireTunnelComponent } from "./components/wire_tunnel";
import { NodiBlueComponent } from "./components/nodi_blue";
import { NodiRedComponent } from "./components/nodi_red";
import { NodiLedComponent } from "./components/nodi_led";
import { NodiBlueDiscusComponent } from "./components/nodi_blue_discus";
import { NodiOperComponent } from "./components/nodi_oper";
import { NodiDataComponent } from "./components/nodi_data";
import { BeltReaderComponent } from "./components/belt_reader";
import { FilterComponent } from "./components/filter";
import { ItemProducerComponent } from "./components/item_producer";
/* typehints:end */

/**
 * Typedefs for all entity components. These are not actually present on the entity,
 * thus they are undefined by default
 */
export class EntityComponentStorage {
    constructor() {
        /* typehints:start */

        /** @type {StaticMapEntityComponent} */
        this.StaticMapEntity;

        /** @type {BeltComponent} */
        this.Belt;
        
        /** @type {CondComponent} */
        this.Cond;

        /** @type {ItemEjectorComponent} */
        this.ItemEjector;

        /** @type {ItemAcceptorComponent} */
        this.ItemAcceptor;

        /** @type {MinerComponent} */
        this.Miner;

        /** @type {ItemProcessorComponent} */
        this.ItemProcessor;

        /** @type {UndergroundBeltComponent} */
        this.UndergroundBelt;

        /** @type {HubComponent} */
        this.Hub;

        /** @type {StorageComponent} */
        this.Storage;

        /** @type {WiredPinsComponent} */
        this.WiredPins;

        /** @type {BeltUnderlaysComponent} */
        this.BeltUnderlays;

        /** @type {WireComponent} */
        this.Wire;

        /** @type {ConstantSignalComponent} */
        this.ConstantSignal;

        /** @type {LogicGateComponent} */
        this.LogicGate;

        /** @type {NodiButtonComponent} */
        this.NodiButton;

        /** @type {WireTunnelComponent} */
        this.WireTunnel;

        /** @type {NodiBlueComponent} */
        this.NodiBlue;

        /** @type {NodiRedComponent} */
        this.DisplayRed;

        /** @type {NodiLedComponent} */
        this.NodiLed;

        /** @type {NodiBlueDiscusComponent} */
        this.NodiDiscus;

        /** @type {NodiOperComponent} */
        this.NodiOper;

          /** @type {NodiDataComponent} */
        this.NodiData;      

        /** @type {BeltReaderComponent} */
        this.BeltReader;

        /** @type {FilterComponent} */
        this.Filter;

        /** @type {ItemProducerComponent} */
        this.ItemProducer;

        /* typehints:end */
    }
}
