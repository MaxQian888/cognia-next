/**
 * Session-Importers Bridge (ADR-0062).
 *
 * Resolves `manifest.sessionImporters` contributions on plugin enable (synthetic
 * module-bridge key — field-driven, same posture as `external-agent-adapter`).
 *
 * A session importer is always CODE: the plugin ships a
 * `() => AgentSessionSourceAdapter` factory. The bridge dynamic-imports the entry
 * (in the RENDERER, where plugin code legitimately runs) and registers the
 * returned adapter into the session-source registry under the namespaced id
 * `${pluginId}:${id}`, so it can never shadow a built-in source. Simpler than the
 * external-agent-adapter bridge: importers are stateless (no live agents to
 * restore/tear down), so disable is a plain registry removal.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginSessionImporterDef } from "@/types/plugin/plugin-session-importer"
import { loggers } from "@/lib/plugin/core/logger"
import {
  registerSessionSource,
  unregisterSessionSourcesByPlugin,
  type AgentSessionSourceAdapter,
} from "@/lib/session-import"

export interface SessionImportersBridgeError {
  pluginId: string
  importerId: string
  message: string
}

export interface SessionImportersBridgeResult {
  registered: number
  errors: SessionImportersBridgeError[]
}

export interface SessionImportersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<SessionImportersBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

/** Structural validation. Returns an error message or null. */
function validateDef(def: PluginSessionImporterDef): string | null {
  if (!def.id || typeof def.id !== "string") return "id is required"
  if (!def.label || typeof def.label !== "string") return "label is required"
  if (!def.entry || typeof def.entry !== "string") return "entry is required"
  if (!def.export || typeof def.export !== "string") return "export is required"
  return null
}

export async function registerSessionImportersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: SessionImportersBridgeOptions = {}
): Promise<SessionImportersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.sessionImporters ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior registry entries on re-enable so a re-registration replaces
  // cleanly (importers are stateless, so this is the whole teardown).
  unregisterSessionSourcesByPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: SessionImportersBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    const invalid = validateDef(def)
    if (invalid) {
      errors.push({ pluginId, importerId: def.id ?? "(missing id)", message: invalid })
      loggers.manager.error(
        `[session-importers-bridge] invalid contribution ${pluginId}:${def.id}: ${invalid}`
      )
      continue
    }

    try {
      const resolved = `${installRoot.replace(/[\\/]+$/, "")}/${def.entry.replace(/^[\\/]+/, "")}`
      const mod = await importer(resolved)
      const exported = mod[def.export]
      if (typeof exported !== "function") {
        throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
      }
      const built = (exported as () => AgentSessionSourceAdapter)()
      if (
        !built ||
        typeof built.listSessions !== "function" ||
        typeof built.parseSession !== "function"
      ) {
        throw new Error(`factory "${def.export}" did not return a valid session source`)
      }
      // The manifest declaration is authoritative for the id; the registry
      // namespaces it as `${pluginId}:${def.id}`.
      registerSessionSource({ ...built, id: def.id }, { pluginId })
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, importerId: def.id, message })
      loggers.manager.error(
        `[session-importers-bridge] failed to load importer ${pluginId}:${def.id}: ${message}`
      )
      continue
    }
  }

  return { registered, errors }
}

/** Drop every session source contributed by `pluginId`. */
export function unregisterSessionImportersForPlugin(pluginId: string): void {
  unregisterSessionSourcesByPlugin(pluginId)
}
