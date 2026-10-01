/** Headless registration for the live Node PluginManager (ADR-0059 T-A7). */

import { transport } from "@/lib/tauri"
import type { HeadlessPluginChange } from "@/lib/headless/types"
import { SystemEvents, emitSystemBusEvent } from "@/lib/plugin/messaging/message-bus"
import { disposeOsSandboxExec } from "@/lib/sandbox/os-exec-bridge"
import { disposeMicrovmAdapters } from "@/lib/sandbox/microvm-bridge"

import { registerHeadlessRuntime } from "../registry"

function parsePluginChange(payload: unknown): HeadlessPluginChange | null {
  if (!payload || typeof payload !== "object") return null
  const value = payload as Record<string, unknown>
  // A committed staged update follows the same disk rediscovery as install.
  const action = value.action === "updated" ? "installed" : value.action
  if (action !== "installed" && action !== "restored" && action !== "uninstalled") {
    return null
  }
  if (typeof value.pluginId !== "string" || !value.pluginId.trim()) return null
  if (
    value.accountId !== undefined &&
    value.accountId !== null &&
    typeof value.accountId !== "string"
  ) {
    return null
  }
  return {
    action,
    pluginId: value.pluginId,
    accountId: value.accountId as string | null | undefined,
  }
}

registerHeadlessRuntime({
  name: "plugin-runtime",
  hosts: ["brain"],
  start: async (ctx) => {
    const runtime = ctx.pluginRuntime
    if (!runtime) throw new Error("plugin-runtime requires a Node plugin host adapter")
    await runtime.start()

    // Keep character-pack warnings in step with the theme-pack registry. Pure
    // in-process registry subscription — no Tauri, no DOM — but it booted only
    // from `PluginRuntimeInitializer`, so on a cloud host pack warnings went
    // stale the moment a pack was added or removed (ADR-0059).
    const { installPackWarningRefreshWiring } =
      await import("@/lib/plugin/character-pack/warning-refresh-wiring")
    const disposePackWarnings = installPackWarningRefreshWiring()
    const { installPluginRuntimeLogBridge } =
      await import("@/lib/plugin/devtools/plugin-log-bridge")
    const disposePluginLogs = installPluginRuntimeLogBridge()

    // Cogsets (ADR-0209). A headless host owns its plugin runtime, so it owns
    // the cogset state too: a paired client's switch arrives here as
    // `plugin_cogset_activate` and the follower applies it. Best effort — a
    // cogset failure must not take the plugin runtime down with it.
    const cogsetStops: Array<() => void> = []
    try {
      const [
        { ensureDefaultCogsetOnHost },
        { startDefaultCogsetWriteThrough },
        { startDefaultCogsetFollower },
      ] = await Promise.all([
        import("@/lib/plugin/cogset/bootstrap-default"),
        import("@/lib/plugin/cogset/write-through"),
        import("@/lib/plugin/cogset/follower"),
      ])
      await ensureDefaultCogsetOnHost()
      cogsetStops.push((await startDefaultCogsetWriteThrough()).stop)
      cogsetStops.push((await startDefaultCogsetFollower()).stop)
    } catch (error) {
      ctx.log(
        "warn",
        `cogsets failed to start: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    let pending = Promise.resolve()
    const unsubscribe = transport.subscribe<unknown>("plugin://runtime-changed", (payload) => {
      const change = parsePluginChange(payload)
      if (!change) {
        ctx.log("warn", "plugin runtime ignored a malformed change event")
        return
      }
      if (change.accountId && change.accountId !== ctx.localAccountId) return
      pending = pending
        .then(() => runtime.reconcile(change))
        .catch((error) => {
          ctx.log(
            "error",
            `plugin runtime reconcile failed for ${change.pluginId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        })
    })

    return async () => {
      unsubscribe()
      for (const stop of cogsetStops.splice(0)) stop()
      disposePackWarnings()
      disposePluginLogs()
      await pending
      emitSystemBusEvent(SystemEvents.APP_CLOSING, {})
      try {
        await runtime.stop?.()
      } finally {
        // Both sandbox tiers are registered by the plugin bootstrap, so both
        // are withdrawn here. Settled rather than sequenced: one provider
        // refusing to close must not leave the other registered.
        await Promise.allSettled([disposeMicrovmAdapters(), disposeOsSandboxExec()])
      }
    }
  },
})
