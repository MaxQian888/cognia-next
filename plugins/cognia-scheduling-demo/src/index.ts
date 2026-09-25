/**
 * Scheduling Demo — opt-in EXAMPLE plugin for the `scheduledTasks` surface.
 *
 * Not enabled by default (no `startup` activation event), so a user who never
 * turns it on never gets its task in their scheduler. Its display strings say
 * "(example)"; the scheduled-task contribution has no `nameKey`, so the label
 * is the literal manifest name.
 *
 * Two halves of the scheduledTasks surface:
 *   - DECLARATIVE: `manifest.scheduledTasks[]` → the scheduled-task bridge
 *     creates a real `ScheduledTask` row (type "plugin", paused because of
 *     `defaultEnabled: false`) on enable and deletes it on disable.
 *   - IMPERATIVE: the named `handler` ("demoHeartbeat") must resolve to a real
 *     function — registered here via `ctx.scheduler.registerHandler` and
 *     released through the activation's lifecycle ledger.
 */

import {
  definePlugin,
  definePluginManifest,
  type PluginContext,
  type PluginTaskResult,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const HEARTBEAT_HANDLER = "demoHeartbeat"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    const dispose = ctx.scheduler.registerHandler(
      HEARTBEAT_HANDLER,
      async (): Promise<PluginTaskResult> => {
        ctx.logger.info("scheduling-demo heartbeat fired")
        return { success: true }
      }
    )
    ctx.lifecycle.onDispose(dispose, "cognia-scheduling-demo:heartbeat-handler")
  },
})
