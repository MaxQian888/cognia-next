/**
 * Plugin-contributed semantic tool routes (`manifest.toolRoutes`) —
 * example utterances attached to the plugin's tools, upserted into the
 * Dexie `toolRoutes` table on enable (source `"manifest"`) and removed on
 * disable. Consumed by `lib/ai/routing/semantic-tool-router.ts`.
 */

export interface PluginToolRouteDef {
  /** Tool name the route targets (a tool this plugin contributes). */
  toolName: string
  /** Example phrasings that should route to this tool. */
  utterances: string[]
  /** Optional per-route similarity floor (overrides the global setting). */
  threshold?: number
}
