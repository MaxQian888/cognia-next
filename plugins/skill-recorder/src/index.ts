/**
 * Skill Recorder — built-in plugin (record-and-replay).
 *
 * Registers:
 *   * a `/record-skill` slash command that opens the recorder modal (the
 *     verified-mounted plugin UI surface; see `ctx.modal`),
 *   * a read-only `record_skill_status` agent tool so an agent can answer
 *     "is a recording running?".
 *
 * Desktop-only: recording needs a native global input hook. On a non-Tauri
 * runtime the slash command returns a "desktop only" message and the tool
 * returns `{ ok: false }` rather than throwing.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { isTauri } from "@/lib/tauri"
import { recordStatus } from "@/lib/skills/recording/recorder-client"
import { RecordSkillModal } from "./ui/record-skill-modal"
import manifestJson from "../plugin.json"

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("skill-recorder plugin activated")

    ctx.agent?.registerTool?.({
      name: "record_skill_status",
      pluginId: ctx.pluginId,
      definition: {
        name: "record_skill_status",
        description: "Report whether a desktop skill recording is currently in progress.",
        parametersSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      } as never,
      execute: async () => {
        if (!isTauri()) {
          return { ok: false as const, error: "desktop-only" }
        }
        try {
          const status = await recordStatus()
          return { ok: true as const, recording: status.recording, stepCount: status.stepCount }
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration and teardown, so `deactivate` has nothing to
    // undo for it.
    return {
      onCommand: async (command: string) => {
        if (command !== "record-skill") return false
        if (!isTauri()) {
          ctx.ui?.showToast?.("Skill recording is desktop-only.", "error")
          return true
        }
        if (!ctx.modal) {
          ctx.ui?.showToast?.("The recorder UI is unavailable in this surface.", "error")
          return true
        }
        ctx.modal.openModal(RecordSkillModal)
        return true
      },
    }
  },
}

export default definition
