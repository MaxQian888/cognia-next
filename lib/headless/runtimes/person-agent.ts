/**
 * `person-agent` — a member partition's sandboxed agents (P6e, plan §9b.5).
 *
 * Person brains only, and only when the Host advertised
 * `COGNIA_PERSON_EXECUTION=sandboxed` (its sandbox pool conforms). It installs
 * the partition's external-agent host (spawn rewritten to the person contract,
 * files/terminals/hooks refused) and the per-conversation runner HostState
 * dispatch hands member turns to. Teardown stops every member agent process.
 *
 * This widens what a member's partition process does on a shared Host: it can
 * now start that member's agent. Everything it starts is placed by the Host in
 * gVisor with egress off and only the member's personal workspace mounted.
 */

import { personChatCapability } from "@/lib/headless/person-chat"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "person-agent",
  criticality: "optional",
  hosts: ["person-brain"],
  start: async (ctx) => {
    if (personChatCapability().execution !== "sandboxed") return () => {}
    const [{ installPersonAgents }, { getExternalAgentManager }, { transport }] = await Promise.all(
      [
        import("@/lib/headless/person-agent"),
        import("@/lib/ai/agent/external/manager"),
        import("@/lib/tauri/transport-instance"),
      ]
    )
    const stop = await installPersonAgents({
      transport,
      manager: getExternalAgentManager(),
      log: (level, message) => ctx.log(level, message),
    })
    return () => {
      void stop().catch((error) =>
        ctx.log("error", `person agent teardown failed: ${String(error)}`)
      )
    }
  },
})
