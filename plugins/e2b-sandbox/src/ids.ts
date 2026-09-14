export const PLUGIN_ID = "cognia-e2b-sandbox" as const

/**
 * Rail group the panel claims — its own, not `inspect`: the rail draws ONE
 * button per activity, and `inspect` already holds several built-in panels, so
 * a seventh would sit behind a `⋯` overflow. Non-canonical ids sort after the
 * canonical ones, so this button lands at the end of the rail.
 * (`plugins/sre-agent/src/ids.ts` precedent.)
 */
export const PANEL_ACTIVITY = "e2b-sandboxes" as const

/** Local id of the Context Workbench panel (namespaced `<pluginId>:sandboxes`). */
export const PANEL_ID = "sandboxes" as const

/** Namespaced panel id, as the workbench registry stores it. */
export const PANEL_FULL_ID = `${PLUGIN_ID}:${PANEL_ID}` as const

/** `ctx.secrets` key under which the E2B/AgentENV API key is kept. */
export const SECRET_API_KEY = "e2b.apiKey" as const
