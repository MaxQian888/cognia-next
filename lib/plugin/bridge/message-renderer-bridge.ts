/**
 * Message-Part Renderer Bridge.
 *
 * Resolves `manifest.messageRenderers` contributions on plugin enable.
 * Each entry is a lazy factory: `{ partType, entry, export }`. The bridge
 * dynamic-imports `entry`, looks up the named React component export, and
 * registers it with `lib/plugin/api/message-part-renderers.ts:registerMessagePartRenderer`.
 *
 * The renderer registry already supports auto-cleanup per plugin via
 * `clearMessagePartRenderersForPlugin(pluginId)`, called by the plugin
 * manager on disable.
 *
 * See ADR-0026 §2 §E.
 */

import type React from "react"
import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginMessageRendererDef,
  MessagePartRendererProps,
} from "@/types/plugin/plugin-message-renderer"
import { loggers } from "@/lib/plugin/core/logger"
import {
  registerMessagePartRenderer,
  clearMessagePartRenderersForPlugin,
} from "@/lib/plugin/api/message-part-renderers"

export interface MessageRendererBridgeError {
  pluginId: string
  partType: string
  message: string
}

export interface MessageRendererBridgeResult {
  registered: number
  errors: MessageRendererBridgeError[]
}

export interface MessageRendererBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<MessageRendererBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

const RESERVED_PREFIXES = ["tool-", "text", "reasoning", "file"]
const RESERVED_TYPES = new Set([
  "a2ui",
  "subagent",
  "agent-team-dispatch",
  "artifact",
  "sources",
  "canvas",
])

function isReservedPartType(type: string): boolean {
  if (!type) return true
  if (RESERVED_TYPES.has(type)) return true
  for (const prefix of RESERVED_PREFIXES) {
    if (type.startsWith(prefix)) return true
  }
  return false
}

export async function registerMessageRenderersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: MessageRendererBridgeOptions = {}
): Promise<MessageRendererBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.messageRenderers ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior so re-enable doesn't double-register.
  clearMessagePartRenderersForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: MessageRendererBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      if (isReservedPartType(def.partType)) {
        throw new Error(
          `partType "${def.partType}" is reserved by the host; pick a plugin-prefixed type`
        )
      }
      const component = await resolveRenderer(def, installRoot, importer)
      registerMessagePartRenderer(pluginId, def.partType, component)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, partType: def.partType, message })
      loggers.manager.error(
        `[message-renderer-bridge] failed to register ${pluginId} renderer for "${def.partType}"`,
        err
      )
    }
  }

  return { registered, errors }
}

async function resolveRenderer(
  def: PluginMessageRendererDef,
  installRoot: string,
  importer: NonNullable<MessageRendererBridgeOptions["importer"]>
): Promise<React.ComponentType<MessagePartRendererProps>> {
  const resolved = `${installRoot.replace(/[\\/]+$/, "")}/${def.entry.replace(/^[\\/]+/, "")}`
  const mod = await importer(resolved)
  const exported = mod[def.export]
  if (typeof exported !== "function") {
    throw new Error(`entry "${def.entry}" does not export a React component named "${def.export}"`)
  }
  return exported as React.ComponentType<MessagePartRendererProps>
}

export function unregisterMessageRenderersForPlugin(pluginId: string): void {
  clearMessagePartRenderersForPlugin(pluginId)
}
