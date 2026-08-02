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
 * browser and mobile `blocked`, so `activate` never runs there.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { isTauri } from "@/lib/tauri"
import { recordStatus } from "@/lib/skills/recording/recorder-client"
import {
  clearRecorderAvailability,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import manifestJson from "../plugin.json"

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("skill-recorder plugin activated")

    // Publish before anything else: the entry points read this to decide
    // whether to render at all.
    setRecorderAvailability({ available: true, pluginId: ctx.pluginId })

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
          // The store is the authority on flow phase; the native status is the
          // authority on whether capture is actually running. Prefer the store
          // when it has a session, so "paused" and "reviewing" are not reported
          // as "not recording".
          const { recorderStatusSnapshot } = await import("@/stores/skills/recorder-store")
          const local = recorderStatusSnapshot()
          if (local.phase !== "idle") {
            return {
              ok: true as const,
              recording: local.recording,
              phase: local.phase,
              stepCount: local.stepCount,
            }
          }
          const status = await recordStatus()
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
        const { openRecorder } = await import("@/stores/skills/recorder-store")
        openRecorder("plugin-command")
        return true
      },
    }
  },
  deactivate: async () => {
    // Withdraws every entry point at once. Without this the toolbar button and
    // the shortcut would survive a disable and fail at the preflight instead.
    clearRecorderAvailability()
  },
}

export default definition
