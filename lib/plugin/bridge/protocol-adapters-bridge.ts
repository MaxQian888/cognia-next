/**
 * Protocol Adapters Bridge.
 *
 * Resolves `manifest.protocolAdapters` contributions on plugin enable
 * (synthetic module-bridge key — field-driven, no capability tag, same
 * posture as `routing-strategy`).
 *
 * Two flavors:
 *   - `kind: "openai-compatible-variant"` — pure DATA: a declarative spec
 *     validated here and registered under `${pluginId}:${id}`. NO dynamic
 *     import (the executing side is the sidecar, which never loads plugin
 *     code).
 *   - `kind: "code"` (P2-E) — the plugin ships a factory; the bridge
 *     dynamic-imports it (ADR-0026 lazy entry, in the RENDERER where plugin
 *     code legitimately runs) and registers the executor. The sidecar still
 *     never loads it — execution round-trips back to the renderer.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  CodeProtocolAdapterFactory,
  PluginProtocolAdapterDef,
} from "@/types/plugin/plugin-protocol-adapter"
import { loggers } from "@/lib/plugin/core/logger"
import {
  registerCodeAdapterExecutor,
  registerProtocolAdapter,
  unregisterCodeAdapterExecutorsByPlugin,
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

export interface ProtocolAdaptersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<ProtocolAdaptersBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

/** Structural validation. Returns an error message or null. */
function validateDef(def: PluginProtocolAdapterDef): string | null {
  if (!def.id || typeof def.id !== "string") return "id is required"
  if (!def.label || typeof def.label !== "string") return "label is required"
  const spec = def.spec
  if (!spec || typeof spec !== "object") return "spec must be an object"
  if (spec.kind === "openai-compatible-variant") {
    if (typeof spec.urlTemplate !== "string" || spec.urlTemplate.length === 0) {
      return "spec.urlTemplate is required"
    }
    if (!spec.responsePaths || typeof spec.responsePaths.textDelta !== "string") {
      return "spec.responsePaths.textDelta is required"
    }
    return null
  }
  if (spec.kind === "code") {
    if (!def.entry || !def.export) return "code adapter requires entry + export"
    return null
  }
  return `unknown spec kind: ${(spec as { kind?: string })?.kind}`
}

export async function registerProtocolAdaptersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: ProtocolAdaptersBridgeOptions = {}
): Promise<ProtocolAdaptersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.protocolAdapters ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior on re-enable.
  unregisterProtocolAdaptersForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
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

    // Code adapters: import + register the executor (renderer-side).
    if (def.spec.kind === "code") {
      try {
        const resolved = `${installRoot.replace(/[\\/]+$/, "")}/${def.entry!.replace(/^[\\/]+/, "")}`
        const mod = await importer(resolved)
        const exported = mod[def.export!]
        if (typeof exported !== "function") {
          throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
        }
        registerCodeAdapterExecutor(adapterId, exported as CodeProtocolAdapterFactory, pluginId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ pluginId, adapterId: def.id, message })
        loggers.manager.error(
          `[protocol-adapters-bridge] failed to load code adapter ${adapterId}: ${message}`
        )
        continue
      }
    }

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
  unregisterCodeAdapterExecutorsByPlugin(pluginId)
}
