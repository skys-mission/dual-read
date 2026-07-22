// Standalone bundle: exposes the pure-DOM collector on window so a headless
// browser can run collectUnits() against real pages (no chrome APIs, no LLM).
import { collectUnits, collectVisibleTextNodes, isOursElement } from '../../lib/collector';

declare global {
  interface Window {
    __DR_PROBE: {
      collectUnits: typeof collectUnits;
      collectVisibleTextNodes: typeof collectVisibleTextNodes;
      isOursElement: typeof isOursElement;
    };
  }
}

window.__DR_PROBE = { collectUnits, collectVisibleTextNodes, isOursElement };
