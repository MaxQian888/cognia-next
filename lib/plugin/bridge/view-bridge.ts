/**
 * View bridge (B2).
 *
 * Resolves `manifest.views[]` contributions on plugin enable. Each entry is a
 * lazy factory `{ id, containerId, type, entry, export }`. The bridge
 * dynamic-imports `entry`, resolves the named export (a `TreeDataProvider` /
 * factory for `type: "tree"`, a React component for `type: "react"`), and
 * registers a resolved view with `lib/plugin/registries/tree-view-registry.ts`.
 *
 * The view's `containerId` is namespaced to `<pluginId>:<containerId>` so it
 * matches the B1 view-container `fullId` the panel reads. Mirrors the
 * message-renderer bridge shape so it plugs into MODULE_BRIDGE_CAPABILITIES.
 */

import type React from "react"
import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginViewDef,
  PluginViewProps,
  ResolvedPluginView,
  TreeDataProvider,
} from "@/types/plugin/plugin-view"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import { registerView, unregisterViewsByPlugin } from "@/lib/plugin/registries/tree-view-registry"

export interface ViewBridgeError {
  pluginId: string
  viewId: string
  message: string
}

export interface ViewBridgeResult {
  registered: number
  errors: ViewBridgeError[]
}

export interface ViewBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<ViewBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function registerViewsForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: ViewBridgeOptions = {}
): Promise<ViewBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.views ?? []
  if (defs.length === 0) return { registered: 0, errors: [] }

  // Clear prior so re-enable doesn't double-register.
  unregisterViewsByPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: ViewBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      const resolved = await resolveView(def, pluginId, installRoot, importer)
      registerView(resolved)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, viewId: def.id, message })
      loggers.manager.error(`[view-bridge] failed to register ${pluginId} view "${def.id}"`, err)
    }
  }

  return { registered, errors }
}

async function resolveView(
  def: PluginViewDef,
  pluginId: string,
  installRoot: string,
  importer: NonNullable<ViewBridgeOptions["importer"]>
): Promise<ResolvedPluginView> {
  const resolvedEntry = resolvePluginPath(installRoot, def.entry)
  const mod = await importer(resolvedEntry)
  const exported = mod[def.export]
  if (exported == null) {
    throw new Error(`entry "${def.entry}" has no export named "${def.export}"`)
  }

  const containerId = `${pluginId}:${def.containerId}`
  const base = {
    pluginId,
    viewId: def.id,
    containerId,
    title: def.title,
    when: def.when,
  } as const

  if (def.type === "tree") {
    // The export may be a TreeDataProvider directly or a zero-arg factory.
    const provider =
      typeof exported === "function"
        ? (exported as () => TreeDataProvider)()
        : (exported as TreeDataProvider)
    if (!provider || typeof provider.getChildren !== "function") {
      throw new Error(`tree view "${def.id}" export "${def.export}" is not a TreeDataProvider`)
    }
    return { kind: "tree", ...base, provider }
  }

  if (typeof exported !== "function") {
    throw new Error(`react view "${def.id}" export "${def.export}" is not a React component`)
  }
  return {
    kind: "react",
    ...base,
    component: exported as React.ComponentType<PluginViewProps>,
  }
}

export function unregisterViewsForPlugin(pluginId: string): void {
  unregisterViewsByPlugin(pluginId)
}
