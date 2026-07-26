/**
 * Tool-Result Renderer Bridge.
 *
 * Resolves `manifest.toolRenderers` contributions on plugin enable. Each entry
 * is a lazy factory: `{ toolName, entry, export }`. The bridge dynamic-imports
 * `entry`, looks up the named React component export, and registers it with
 * `lib/plugin/api/tool-result-renderers.ts:registerToolResultRenderer`.
 *
 * Direct counterpart of `message-renderer-bridge.ts`; the only real difference
 * is the registry key (a tool name rather than a part type) and the absence of
 * a reserved-name check — the host's built-in card table is consulted before
 * this registry, so shadowing a built-in is impossible rather than forbidden.
 * See ADR-0026 §2 §E.
 */

import type React from "react"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginToolRendererDef } from "@/types/plugin/plugin-tool-renderer"
import type { ToolResultRendererProps } from "@/lib/plugin/api/tool-result-renderers"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  registerToolResultRenderer,
  clearToolResultRenderersForPlugin,
} from "@/lib/plugin/api/tool-result-renderers"

export interface ToolRendererBridgeError {
  pluginId: string
  toolName: string
  message: string
}

export interface ToolRendererBridgeResult {
  registered: number
  errors: ToolRendererBridgeError[]
}

export interface ToolRendererBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<ToolRendererBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function registerToolRenderersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: ToolRendererBridgeOptions = {}
): Promise<ToolRendererBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.toolRenderers ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior so re-enable doesn't double-register.
  clearToolResultRenderersForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: ToolRendererBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      const toolName = typeof def.toolName === "string" ? def.toolName.trim() : ""
      if (!toolName) {
        throw new Error(`toolRenderers entry is missing a "toolName"`)
      }
      const component = await resolveRenderer(def, installRoot, importer)
      registerToolResultRenderer(pluginId, toolName, component)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, toolName: def.toolName, message })
      loggers.manager.error(
        `[tool-renderer-bridge] failed to register ${pluginId} renderer for "${def.toolName}"`,
        err
      )
    }
  }

  return { registered, errors }
}

async function resolveRenderer(
  def: PluginToolRendererDef,
  installRoot: string,
  importer: NonNullable<ToolRendererBridgeOptions["importer"]>
): Promise<React.ComponentType<ToolResultRendererProps>> {
  const resolved = resolvePluginPath(installRoot, def.entry)
  const mod = await importer(resolved)
  const exported = mod[def.export]
  if (typeof exported !== "function") {
    throw new Error(`entry "${def.entry}" does not export a React component named "${def.export}"`)
  }
  return exported as React.ComponentType<ToolResultRendererProps>
}

export function unregisterToolRenderersForPlugin(pluginId: string): void {
  clearToolResultRenderersForPlugin(pluginId)
}
