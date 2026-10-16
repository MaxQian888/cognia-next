// Side-effect module: install the overlay prelude in this world. Imported by
// `src/app/agent-overlay.ts` BEFORE the overlay, because ES imports run in
// order and before the importing module's own body.
import { installOverlayPrelude } from "./overlay-prelude"

installOverlayPrelude(window as unknown as Window & Record<string, unknown>, (url) => {
  void chrome.runtime.sendMessage({ kind: "cognia-agent-open-tab", url })
})
