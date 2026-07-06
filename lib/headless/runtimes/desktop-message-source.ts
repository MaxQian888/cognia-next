/**
 * Headless registration of the desktop message + write sources
 * (ADR-0059 T-A3).
 *
 * Mirrors `DesktopMessageSourceProvider`, which installs BOTH installers in
 * one effect: the five message/session RPCs and the generic desktop-write
 * command channel. Composed teardown, reverse order.
 */
import { installDesktopMessageSource } from "@/lib/companion/desktop-message-source"
import { installDesktopWriteSource } from "@/lib/companion/desktop-write-source"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "desktop-message-source",
  hosts: ["brain"],
  start: async (ctx) => {
    const unsubMessages = await installDesktopMessageSource({ bridge: ctx.bridge })
    const unsubWrites = await installDesktopWriteSource({ bridge: ctx.bridge })
    return () => {
      unsubWrites()
      unsubMessages()
    }
  },
})
