/**
 * Scheduling Demo — built-in reference plugin.
 *
 * Two halves of the scheduledTasks surface:
 *   - DECLARATIVE: `manifest.scheduledTasks[]` → the scheduled-task bridge
 *     creates a real `ScheduledTask` Dexie row (type "plugin") on enable and
 *     deletes it on disable.
 *   - IMPERATIVE: the named `handler` ("demoHeartbeat") must resolve to a real
 *     function — registered here via `ctx.scheduler.registerHandler` in
 *     activate, torn down in deactivate. (The handler name in the manifest is
 *     just a reference; builtins can't ship a separately-imported handler
 *     module, so the function is provided at activation.)
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import manifest from "../plugin.json"

const HANDLER_NAME = "demoHeartbeat"

let disposeHandler: (() => void) | null = null

const definition: PluginDefinition = {
  manifest: manifest as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("scheduling-demo activated")
    disposeHandler =
      ctx.scheduler?.registerHandler?.(HANDLER_NAME, async () => {
        ctx.logger?.info("scheduling-demo heartbeat fired")
        return { success: true as const }
      }) ?? null
  },
  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger?.info("scheduling-demo deactivated")
    disposeHandler?.()
    disposeHandler = null
  },
}

export default definition
