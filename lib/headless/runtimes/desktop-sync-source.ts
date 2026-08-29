/**
 * Headless registration of the desktop sync source (ADR-0059 T-A2).
 *
 * `installDesktopSyncSource` was already bridge-injectable — the brain
 * reuses it VERBATIM with the socket-backed bridge from the runtime
 * context, so `sync_pull` answers from the brain's Dexie exactly as the
 * desktop WebView answers from its own.
 */
import { installDesktopSyncSource } from "@/lib/sync/desktop-sync-source"
import { installHostTableInvalidation } from "@/lib/sync/host-table-invalidation"
import { installAgentTeamProjection } from "@/lib/db/agent-team-projection"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "desktop-sync-source",
  hosts: ["brain"],
  start: async (ctx) => {
    // The board projection (store → `agentTeamBoard`, v104) must run wherever
    // the sync source answers pulls, or the brain would serve an empty board.
    const uninstallProjection = installAgentTeamProjection()
    // The push half of the protocol. Without it the brain answers `sync_pull`
    // correctly and never tells anyone to call it, so a web or mobile client
    // paired to a headless Host only learned about a change when something
    // else happened to trigger a pull.
    const uninstallInvalidation = installHostTableInvalidation()
    const uninstallSource = await installDesktopSyncSource({ bridge: ctx.bridge })
    return () => {
      uninstallInvalidation()
      uninstallProjection()
      uninstallSource()
    }
  },
})
