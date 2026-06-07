/**
 * Protocol Adapters Bridge.
 *
 * Resolves `manifest.protocolAdapters` contributions on plugin enable
 * (synthetic module-bridge key — field-driven, no capability tag, same
 * posture as `routing-strategy`). Unlike the code-loading bridges, entries
 * are pure DATA: a declarative `openai-compatible-variant` spec validated
 * here and registered under the namespaced id `${pluginId}:${def.id}` — NO
 * dynamic import happens, by design (the executing side is the sidecar,
 * which must never load plugin code).
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginProtocolAdapterDef } from "@/types/plugin/plugin-protocol-adapter"
import { loggers } from "@/lib/plugin/core/logger"
import {
  registerProtocolAdapter,
  unregisterProtocolAdaptersByPlugin,
} from "@/lib/ai/providers/protocol-adapter-registry"

export interface ProtocolAdaptersBridgeError {
  pluginId: string
  adapterId: string
  message: string
}

export interface ProtocolAdaptersBridgeResult {
  registered: number
  errors: ProtocolAdaptersBridgeError[]
}

/** Mirror of the sidecar adapter's structural requirements (parity-tested). */
function validateDef(def: PluginProtocolAdapterDef): string | null {
  if (!def.id || typeof def.id !== "string") return "id is required"
  if (!def.label || typeof def.label !== "string") return "label is required"
  const spec = def.spec
  if (!spec || typeof spec !== "object") return "spec must be an object"
  if (spec.kind !== "openai-compatible-variant") {
    return `unknown spec kind: ${(spec as { kind?: string })?.kind}`
  }
  if (typeof spec.urlTemplate !== "string" || spec.urlTemplate.length === 0) {
    return "spec.urlTemplate is required"
  }
  if (!spec.responsePaths || typeof spec.responsePaths.textDelta !== "string") {
    return "spec.responsePaths.textDelta is required"
  }
  return null
}

export async function registerProtocolAdaptersForPlugin(
  manifest: PluginManifest,
  _installRoot: string
): Promise<ProtocolAdaptersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.protocolAdapters ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior on re-enable.
  unregisterProtocolAdaptersForPlugin(pluginId)

  const errors: ProtocolAdaptersBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    const invalid = validateDef(def)
    if (invalid) {
      errors.push({ pluginId, adapterId: def.id ?? "(missing id)", message: invalid })
      loggers.manager.error(
        `[protocol-adapters-bridge] invalid contribution ${pluginId}:${def.id}: ${invalid}`
      )
      continue
    }
    const adapterId = `${pluginId}:${def.id}`
    const ok = registerProtocolAdapter({ ...def, id: adapterId }, { pluginId })
    if (!ok) {
      // Unreachable through the namespaced id, but keep the signal honest.
      errors.push({ pluginId, adapterId: def.id, message: "id collides with a built-in protocol" })
      continue
    }
    registered++
  }

  return { registered, errors }
}

export function unregisterProtocolAdaptersForPlugin(pluginId: string): void {
  unregisterProtocolAdaptersByPlugin(pluginId)
}
