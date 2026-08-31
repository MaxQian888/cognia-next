/** Headless registration for the live Node PluginManager (ADR-0059 T-A7). */

import { transport } from "@/lib/tauri"
import type { HeadlessPluginChange } from "@/lib/headless/types"
import { SystemEvents, emitSystemBusEvent } from "@/lib/plugin/messaging/message-bus"
import { disposeMicrovmAdapters } from "@/lib/sandbox/microvm-bridge"

import { registerHeadlessRuntime } from "../registry"

function parsePluginChange(payload: unknown): HeadlessPluginChange | null {
  if (!payload || typeof payload !== "object") return null
  const value = payload as Record<string, unknown>
  if (
    value.action !== "installed" &&
    value.action !== "restored" &&
    value.action !== "uninstalled"
  ) {
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
    action: value.action,
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

    let pending = Promise.resolve()
    const unsubscribe = transport.subscribe<unknown>("plugin://runtime-changed", (payload) => {
      const change = parsePluginChange(payload)
      if (!change) {
        ctx.log("warn", "plugin runtime ignored a malformed change event")
        return
      }
      if (change.accountId && change.accountId !== ctx.accountId) return
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
      disposePackWarnings()
      await pending
      emitSystemBusEvent(SystemEvents.APP_CLOSING, {})
      try {
        await runtime.stop?.()
      } finally {
        await disposeMicrovmAdapters()
      }
    }
  },
})
