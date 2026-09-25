/**
 * Skill Recorder — built-in plugin.
 *
 * This plugin is the recorder's **permission and feature owner**, not its UI.
 * Its manifest declares the three native grants (`native:input`,
 * `native:screen`, `media:image:write`) that a recording needs, and its enabled
 * state is what `record_preflight` reads to decide whether recording is allowed
 * at all.
 *
 * The UI moved out deliberately. The recorder is a five-stage flow with a
 * floating always-on-top controller, crash recovery, and four entry points on
 * four different routes — none of which fits inside `ctx.modal`, and all of
 * which need the same live state. So this file does three small things:
 *
 *   1. publishes availability, so every entry point (Skills toolbar, command
 *      palette, `/record-skill`, the `skills.record` shortcut) disappears when
 *      the plugin is disabled — without any of them importing plugin internals;
 *   2. routes its declared `record-skill` command to the global recorder;
 *   3. exposes a read-only `record_skill_status` agent tool.
 *
 * Desktop-only: recording needs a native global input hook. The manifest marks
 * browser and mobile `blocked` (headless inherits browser), so `activate` only
 * ever runs in the Tauri shell and needs no platform check of its own.
 */

import {
  definePlugin,
  definePluginManifest,
  definePluginTool,
  type PluginCommandResult,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

// plugin.json is the manifest source of truth — `commands[]` and the
// `i18n.locales` bundle the manager registers before `activate()` runs.
export const manifest = definePluginManifest(manifestJson)

function recordSkillStatusTool(ctx: PluginContext) {
  return definePluginTool({
    name: "record_skill_status",
    definition: {
      name: "record_skill_status",
      description: "Report whether a desktop skill recording is currently in progress.",
      parametersSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    execute: async () => {
      try {
        // The store is the authority on flow phase; the native status is the
        // authority on whether capture is actually running. Prefer the store
        // when it has a session, so "paused" and "reviewing" are not reported
        // as "not recording".
        const local = ctx.recorder.statusSnapshot()
        if (local.phase !== "idle") {
          return {
            ok: true as const,
            recording: local.recording,
            phase: local.phase,
            stepCount: local.stepCount,
          }
        }
        const status = await ctx.recorder.status()
        return {
          ok: true as const,
          recording: status.recording,
          phase: status.phase ?? "idle",
          stepCount: status.stepCount,
        }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

export default definePlugin({
  manifest,
  activate: (ctx) => {
    // Publish before anything else: the entry points read this to decide
    // whether to render at all. Withdrawn on dispose, so the toolbar button and
    // the shortcut disappear with the plugin instead of failing at preflight.
    ctx.lifecycle.onDispose(ctx.recorder.publishAvailability(), "skill-recorder:availability")
    ctx.agent.registerTool(recordSkillStatusTool(ctx))
    ctx.logger.info("skill-recorder plugin activated")

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here; the manager owns its registration and teardown.
    return {
      onCommand: (command: string): boolean | PluginCommandResult => {
        if (command !== "record-skill") return false
        try {
          ctx.recorder.open("plugin-command")
          return { handled: true, message: ctx.i18n.t("command.opened") }
        } catch (err) {
          const message = ctx.i18n.t("command.openFailed", {
            error: err instanceof Error ? err.message : String(err),
          })
          ctx.ui.showToast(message, "error")
          return { handled: true, message }
        }
      },
    }
  },
})
