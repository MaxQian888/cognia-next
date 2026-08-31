/**
 * The write half of the plugin analytics loop.
 *
 * `lib/db/plugin-analytics.ts` shipped a full counter store (`incrementAnalytic`
 * / `listAnalyticsForPlugin` / `clearAnalyticsForPlugin`) and had ZERO
 * importers, so nothing ever wrote a row. `hooks/plugins/use-plugin-analytics`
 * reads that table directly, which meant Governance's Analytics view was
 * permanently empty and could only ever have been empty. The loop was severed
 * at the write end.
 *
 * This is deliberately narrow. Two events are recorded (a plugin surface that
 * threw, and an enable/disable transition), because those are the two the
 * product already funnels through one place each. Per-tool-call telemetry has
 * no single funnel yet and needs its own seam rather than a call sprinkled
 * across the dispatch paths.
 */

import { loggers } from "@cognia/logging"

/** Stable counter keys. A renamed key silently starts a new counter. */
export const PLUGIN_ANALYTIC_KEYS = {
  enabled: "lifecycle.enabled",
  disabled: "lifecycle.disabled",
  surfaceError: "surface.error",
} as const

export type PluginAnalyticKey = (typeof PLUGIN_ANALYTIC_KEYS)[keyof typeof PLUGIN_ANALYTIC_KEYS]

/**
 * Best-effort and non-blocking: analytics must never fail a user action, and
 * the Dexie module is imported lazily so a caller on a path with no database
 * (SSR, a test that never opened one) does not drag it in.
 */
export async function recordPluginAnalytic(
  pluginId: string,
  key: PluginAnalyticKey
): Promise<void> {
  try {
    const { incrementAnalytic } = await import("@/lib/db/plugin-analytics")
    await incrementAnalytic(pluginId, key)
  } catch (error) {
    loggers.plugin.debug("Skipped plugin analytics write", {
      pluginId,
      key,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
