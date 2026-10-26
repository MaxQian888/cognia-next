/**
 * Headless registration of the desktop message, write, and orchestration sources
 * (ADR-0059 T-A3).
 *
 * Reuses the same three plain-TS installers as Desktop: message/session RPCs,
 * the generic desktop-write channel, and the External Bridge orchestration
 * proxy. Composed teardown runs in reverse order.
 */
import { installDesktopMessageSource } from "@/lib/companion/desktop-message-source"
import { installDesktopWriteSource } from "@/lib/companion/desktop-write-source"
import { installOrchestrationDispatchSource } from "@/lib/external-bridge/orchestration-ipc"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "desktop-message-source",
  criticality: "required",
  hosts: ["brain", "person-brain"],
  start: async (ctx) => {
    const unsubMessages = await installDesktopMessageSource({ bridge: ctx.bridge })
    const unsubWrites = await installDesktopWriteSource({
      bridge: ctx.bridge,
      ...(ctx.host === "person-brain" ? { partition: true } : {}),
    })
    // A person brain is data-only (plan §9a): it never proxies orchestration.
    const unsubOrchestration =
      ctx.host === "person-brain"
        ? () => undefined
        : await installOrchestrationDispatchSource({
            bridge: ctx.bridge,
            onError: (error) =>
              ctx.log(
                "error",
                `orchestration proxy response failed: ${
                  error instanceof Error ? error.message : String(error)
                }`
              ),
          })
    return () => {
      unsubOrchestration()
      unsubWrites()
      unsubMessages()
    }
  },
})
