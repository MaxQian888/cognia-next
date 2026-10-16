// The overlay the agent executor injects into a tab's isolated world
// (ADR-0228 §6): the prelude that disarms the overlay's sentinel channels,
// then `lib/browser/overlay.injected.js` itself — the same file the embedded
// engine injects, so snapshot refs mean the same thing on every backend.
// Import order is execution order, so the prelude is imported first.
import "@ext/src/lib/agent/overlay-prelude-install"
import "@cognia-overlay"

import { defineUnlistedScript } from "wxt/utils/define-unlisted-script"

export default defineUnlistedScript(() => undefined)
