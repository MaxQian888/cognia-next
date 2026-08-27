export const PLUGIN_ID = "sre-agent" as const

export const SRE_SUBAGENT_ID = "incident-diagnostician" as const

/** Project a plugin-local subagent id into the host registry namespace. */
export function sreSubagentRuntimeId(localId = SRE_SUBAGENT_ID): string {
  return `${PLUGIN_ID}:${localId}`
}

/**
 * Rail group the panel claims.
 *
 * Its own, not `inspect`: the rail draws ONE button per activity, and `inspect`
 * already holds six built-in panels (run context, session sources, metadata,
 * memory, logs) — a seventh is a tab behind a `⋯` overflow, which is not where
 * an investigation surface belongs. Non-canonical ids sort after the canonical
 * ones, so this button lands at the end of the rail.
 */
export const PANEL_ACTIVITY = "sre-incidents" as const

/** Local id of the Context Workbench panel (namespaced `<pluginId>:incidents`). */
export const PANEL_ID = "incidents" as const

/** Namespaced panel id, as the workbench registry stores it. */
export const PANEL_FULL_ID = `${PLUGIN_ID}:${PANEL_ID}`
