/**
 * Headless registration of the Browser Companion's agent mode (ADR-0228 §5–§6).
 *
 * A headless Host serves the extension's device socket from its own server,
 * and the brain is where that Host's conversations run. This runtime is the
 * desktop's `BrowserCompanionAgentInitializer` for it: conversations a browser
 * started in agent mode are rebound to that browser on start and unbound while
 * the Owner has revoked its `browser.drive`, and browsers are hinted when one
 * of their submissions moves. Both reach the socket through the brain's
 * service plane (`lib/browser-companion/host-transport.ts`).
 */

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "browser-companion-agent",
  criticality: "optional",
  hosts: ["brain"],
  start: async () => {
    const { startBrowserCompanionAgentRuntime } =
      await import("@/lib/browser-companion/host-dispatch")
    return startBrowserCompanionAgentRuntime()
  },
})
