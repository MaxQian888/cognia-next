/**
 * Cognia glance module plugin template (TypeScript).
 *
 * A glance module is a small block in the desktop tray panel and the phone's
 * Glance drawer. The plugin never renders it: it declares the module and
 * publishes DATA (stats, rows, a summary line, buttons), and the host draws it
 * with its own components. This template is a counter, showing every piece:
 *
 *   - the module is declared in `plugin.json` (`glanceModules`, capability
 *     `glance`), titled from the manifest's own `i18n.locales`
 *   - `ctx.glance.update` publishes its data
 *   - `ctx.glance.onVisibilityChange` says when some surface shows it, so the
 *     work behind a module only runs while somebody can see it
 *   - the buttons run this plugin's own manifest commands, answered by
 *     `hooks.onCommand` (they also work as `/template-glance-increment`)
 *   - `ctx.storage` keeps the count across reloads
 *   - teardown goes through `ctx.lifecycle.onDispose`
 *
 * Everything here compiles against `@cognia/plugin-sdk` alone. No host-private
 * module is imported, which is exactly the boundary a published plugin has.
 */

import {
  definePlugin,
  definePluginManifest,
  type PluginCommandResult,
  type PluginContext,
  type PluginGlanceModuleData,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

/** `plugin.json`, typed: one source for the manifest the host reads and this module. */
export const manifest = definePluginManifest(manifestJson)

/** The module's local id in `plugin.json` `glanceModules`. */
export const MODULE_ID = "counter"
/** The manifest commands the module's buttons run (`<pluginId>.<id>` on the host). */
export const INCREMENT_COMMAND = "template-glance-increment"
export const RESET_COMMAND = "template-glance-reset"
/** Where the counter is kept between reloads. */
export const STATE_KEY = "counter"

export interface CounterState {
  count: number
  /** When the count last changed, or null if it never has. */
  changedAt: number | null
}

/** Resolves a manifest i18n key with `{name}` parameters. */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** The module data for a state. Keep it within the host's limits: 4 stats, 8 rows, 3 actions. */
export function buildModuleData(
  state: CounterState,
  t: Translate,
  formatTime: (at: number) => string
): PluginGlanceModuleData {
  return {
    summary: t("summary", { count: state.count }),
    stats: [
      {
        label: t("stat.count"),
        value: String(state.count),
        tone: state.count > 0 ? "ok" : "muted",
      },
      {
        label: t("stat.changed"),
        value: state.changedAt === null ? t("stat.never") : formatTime(state.changedAt),
        tone: "muted",
      },
    ],
    actions: [
      { id: "increment", label: t("action.increment"), icon: "Plus", command: INCREMENT_COMMAND },
      { id: "reset", label: t("action.reset"), icon: "RotateCcw", command: RESET_COMMAND },
    ],
    empty: t("empty"),
  }
}

/** A stored value, checked; anything else starts the count over. */
export function restoreState(raw: unknown): CounterState {
  if (typeof raw !== "object" || raw === null) return { count: 0, changedAt: null }
  const value = raw as Partial<CounterState>
  const count = Number.isInteger(value.count) && (value.count as number) >= 0 ? value.count! : 0
  const changedAt = typeof value.changedAt === "number" ? value.changedAt : null
  return { count, changedAt }
}

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    let state = restoreState(await ctx.storage.get(STATE_KEY))
    let visible = false

    const publish = () => {
      ctx.glance.update(
        MODULE_ID,
        buildModuleData(
          state,
          (key, params) => ctx.i18n.t(key, params),
          (at) => ctx.i18n.formatDate(new Date(at), { hour: "2-digit", minute: "2-digit" })
        )
      )
    }

    // Called at once with the current state, then on every change. Start
    // expensive work (polling, a socket) on `true` and stop it on `false`.
    ctx.lifecycle.onDispose(
      ctx.glance.onVisibilityChange(MODULE_ID, (onScreen) => {
        visible = onScreen
        if (onScreen) publish()
      }),
      "template-glance:visibility"
    )
    // Labels are translated when published, so publish again in the new language.
    ctx.lifecycle.onDispose(
      ctx.i18n.onLocaleChange(() => {
        if (visible) publish()
      }),
      "template-glance:locale"
    )

    return {
      onCommand: async (command: string): Promise<boolean | PluginCommandResult> => {
        if (command !== INCREMENT_COMMAND && command !== RESET_COMMAND) return { handled: false }
        state = {
          count: command === INCREMENT_COMMAND ? state.count + 1 : 0,
          changedAt: Date.now(),
        }
        await ctx.storage.set(STATE_KEY, state)
        // Publish even while hidden, so the next time the module shows (or a
        // paired phone reads it) it is already current.
        publish()
        return { handled: true }
      },
    }
  },
})
