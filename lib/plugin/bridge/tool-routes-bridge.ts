/**
 * Tool Routes Bridge.
 *
 * Persists `manifest.toolRoutes` contributions into the Dexie
 * `toolRoutes` table on plugin enable (source `"manifest"`, tagged with
 * the pluginId) and removes them on disable. Synthetic module-bridge key
 * — data rows rather than lazy factories, so no importer is involved.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginToolRouteDef } from "@/types/plugin/plugin-tool-route"
import { loggers } from "@/lib/plugin/core/logger"

export interface ToolRoutesBridgeResult {
  registered: number
  errors: Array<{ pluginId: string; toolName: string; message: string }>
}

export async function registerToolRoutesForPlugin(
  manifest: PluginManifest,
  _installRoot: string
): Promise<ToolRoutesBridgeResult> {
  const pluginId = manifest.id
  const defs = (manifest.toolRoutes ?? []) as PluginToolRouteDef[]
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  const { upsertToolRoute, makeToolRouteId, deleteToolRoutesByPlugin } =
    await import("@/lib/db/tool-routes")
  // Re-enable replaces the plugin's prior manifest routes wholesale.
  await deleteToolRoutesByPlugin(pluginId)

  const errors: ToolRoutesBridgeResult["errors"] = []
  let registered = 0
  for (const def of defs) {
    try {
      if (typeof def.toolName !== "string" || def.toolName.length === 0) {
        throw new Error("toolRoutes entry requires a non-empty toolName")
      }
      const utterances = (def.utterances ?? []).filter(
        (u): u is string => typeof u === "string" && u.trim().length > 0
      )
      if (utterances.length === 0) {
        throw new Error(`toolRoutes entry "${def.toolName}" requires at least one utterance`)
      }
      await upsertToolRoute({
        id: makeToolRouteId("manifest", "tool", `${pluginId}:${def.toolName}`),
        kind: "tool",
        refId: def.toolName,
        pluginId,
        utterances,
        threshold: typeof def.threshold === "number" ? def.threshold : undefined,
        enabled: true,
        source: "manifest",
        updatedAt: Date.now(),
      })
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, toolName: def?.toolName ?? "?", message })
      loggers.manager.warn(`[tool-routes-bridge] skipped route for ${pluginId}: ${message}`)
    }
  }
  return { registered, errors }
}

export async function unregisterToolRoutesForPlugin(pluginId: string): Promise<void> {
  try {
    const { deleteToolRoutesByPlugin } = await import("@/lib/db/tool-routes")
    await deleteToolRoutesByPlugin(pluginId)
  } catch (err) {
    loggers.manager.warn(`[tool-routes-bridge] cleanup failed for ${pluginId}`, err)
  }
}
