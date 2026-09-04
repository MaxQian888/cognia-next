/**
 * Deep link from a plugin's detail pane into the unified log panel.
 *
 * The detail pane used to embed its own live log list. That reader was a
 * second, weaker copy of `/logs`: no level filter, no time range, no search,
 * no trace correlation, and it emptied itself whenever the pane remounted.
 * Sending the user to the real panel with the filters already applied keeps
 * one log surface in the product.
 *
 * The query keys are the ones `useLogPanelUrlSync` hydrates from at mount
 * (`src`, `q`, `t`) plus the workspace's own `channel`. `/logs` seeds the panel
 * from `window.location.search`, so a full navigation is enough. Nothing here
 * invents a key: an unknown key would be silently carried through and filter
 * nothing.
 */

/** Log-panel source facet that plugin output is tagged with. */
const PLUGIN_LOG_SOURCE = "plugin"

export interface PluginLogsLinkOptions {
  /** Plugin id, used as the panel's free-text query. */
  pluginId: string
  /**
   * Preset time range understood by the panel (`15m` / `1h` / `6h` / `24h` /
   * `7d` / `all`). Defaults to 24h: a plugin's interesting output is its
   * activation, which happened at the last app start.
   */
  timeRange?: "15m" | "1h" | "6h" | "24h" | "7d" | "all"
}

export function buildPluginLogsHref({
  pluginId,
  timeRange = "24h",
}: PluginLogsLinkOptions): string {
  const params = new URLSearchParams()
  params.set("channel", "logs")
  params.set("src", PLUGIN_LOG_SOURCE)
  params.set("q", pluginId)
  // `all` is a range the panel understands like any other
  // (`VALID_TIME_RANGES` in `hooks/logging/use-log-panel-url-sync.ts`), so it
  // has to be written. Omitting it left the panel on whatever its own default
  // is, which made the one option that means "no time filter" the one option
  // the builder could not express.
  params.set("t", timeRange)
  return `/logs?${params.toString()}`
}
