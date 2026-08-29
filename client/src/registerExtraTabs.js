// Sets window.nodigraphExtraTabs *before* nodigraph's own main.js runs
// (see index.html's script order, and nodigraph's own comment on why this
// has to be a pre-set global rather than a parameter it could accept) —
// this is what actually puts the "Logic" tab beside nodigraph's native
// Inspector tab.
import { renderLogicTab } from './logicTab.js';

window.nodigraphExtraTabs = [{ label: 'Logic', render: renderLogicTab }];
