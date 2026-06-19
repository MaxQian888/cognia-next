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
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import { isTauri } from "@/lib/tauri"
import { recordStatus } from "@/lib/skills/recording/recorder-client"
import { RecordSkillModal } from "./ui/record-skill-modal"

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-skill-recorder",
    name: "Skill Recorder",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["commands", "tools"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("skill-recorder plugin activated")

    registerSlashCommand({
      id: "skill-recorder.record",
      name: "/record-skill",
      description: "Record a desktop workflow and turn it into a generated Skill.",
      source: "plugin",
      pluginId: ctx.pluginId,
      handler: () => {
        if (!isTauri()) {
          return { message: "Skill recording is desktop-only." }
        }
        if (!ctx.modal) {
          return { message: "The recorder UI is unavailable in this surface." }
        }
        ctx.modal.openModal(RecordSkillModal)
        return { message: "Recorder opened." }
      },
    })

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
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
      unregisterCommandsByPlugin(ctx.pluginId)
    }
  },
}

export default definition
