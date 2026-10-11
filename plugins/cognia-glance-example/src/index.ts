/**
 * Focus Timer — opt-in EXAMPLE plugin for the tray panel's glance modules
 * (ADR-0225 §6, `docs/content/docs/en/plugin-dev/glance-modules.mdx`).
 *
 * Not enabled by default (no `startup` activation event). Once enabled, the
 * "Focus timer" module appears in the tray panel's and the phone's add list;
 * declaring a module never puts it on screen by itself.
 *
 * Everything a glance module needs, in one small plugin:
 *   - DECLARE: `manifest.glanceModules[]` (the `glance` capability), titled
 *     from the plugin's own i18n bundle.
 *   - PUBLISH: `ctx.glance.update` with stats, a summary for the compact size,
 *     and buttons bound to the plugin's own manifest commands.
 *   - VISIBILITY: `ctx.glance.onVisibilityChange` keeps the minute countdown
 *     ticking only while some glance surface shows the module.
 *   - ACTIONS: the buttons run `<pluginId>.focus-toggle` / `.focus-reset`,
 *     answered by this plugin's `onCommand` hook (also `/focus-toggle`).
 *   - STATE: `ctx.storage`, so a running session survives a reload.
 */

import {
  definePlugin,
  definePluginManifest,
  type PluginCommandResult,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import {
  buildModuleData,
  reset,
  restoreState,
  RESET_COMMAND,
  settle,
  toggle,
  TOGGLE_COMMAND,
  type FocusState,
} from "./timer"

export const manifest = definePluginManifest(manifestJson)

/** The module's local id in `glanceModules`. */
export const MODULE_ID = "focus"
/** Where the timer state is kept between reloads. */
export const STATE_KEY = "focus-state"
/** How often the countdown is republished while the module is on screen. */
export const TICK_MS = 15_000

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    const now = () => Date.now()
    let state: FocusState = restoreState(await ctx.storage.get(STATE_KEY), now())
    let visible = false
    let ticker: ReturnType<typeof setInterval> | undefined

    const publish = () => {
      state = settle(state, now())
      ctx.glance.update(
        MODULE_ID,
        buildModuleData(state, now(), (key, params) => ctx.i18n.t(key, params))
      )
    }

    const persist = async () => {
      try {
        await ctx.storage.set(STATE_KEY, state)
      } catch (error) {
        ctx.logger.warn("focus timer state could not be saved", { error: String(error) })
      }
    }

    const stopTicker = () => {
      if (ticker !== undefined) clearInterval(ticker)
      ticker = undefined
    }

    ctx.lifecycle.onDispose(
      ctx.glance.onVisibilityChange(MODULE_ID, (onScreen) => {
        visible = onScreen
        stopTicker()
        if (!onScreen) return
        publish()
        ticker = setInterval(publish, TICK_MS)
      }),
      "cognia-glance-example:visibility"
    )
    ctx.lifecycle.onDispose(stopTicker, "cognia-glance-example:ticker")
    ctx.lifecycle.onDispose(
      ctx.i18n.onLocaleChange(() => {
        if (visible) publish()
      }),
      "cognia-glance-example:locale"
    )

    return {
      onCommand: async (command: string): Promise<boolean | PluginCommandResult> => {
        if (command !== TOGGLE_COMMAND && command !== RESET_COMMAND) return { handled: false }
        state = command === TOGGLE_COMMAND ? toggle(state, now()) : reset(state, now())
        // Publish even while hidden: a paired phone or the next open shows
        // the change at once instead of after the first tick.
        publish()
        await persist()
        return { handled: true }
      },
    }
  },
})
