/**
 * OCR Providers Bridge.
 *
 * Resolves `manifest.ocrProviders` contributions on plugin enable. Each
 * entry is a lazy factory: `{ id, label, entry, export }`. The bridge
 * dynamic-imports `entry`, looks up the named `export`, calls it with a
 * factory context, and registers the produced `OcrProvider` with the
 * shared OCR registry (via `lib/plugin/api/ocr-api.ts` for the lifecycle
 * + namespacing guarantees).
 *
 * Errors are collected, never thrown — a single bad provider must not
 * block the rest of the plugin's contributions (parity with
 * `themes-bridge.ts`, `connectors-bridge`, `tools-bridge`).
 *
 * See ADR-0026 §2 §A.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginOcrProviderDef, PluginOcrProviderFactory } from "@/types/plugin/plugin-ocr"
import type { OcrProvider } from "@/types/ocr"
import { loggers } from "@/lib/plugin/core/logger"
import { clearOcrProvidersForPlugin, createOcrAPI } from "@/lib/plugin/api/ocr-api"

export interface OcrProvidersBridgeError {
  pluginId: string
  providerId: string
  message: string
}

export interface OcrProvidersBridgeResult {
  registered: number
  errors: OcrProvidersBridgeError[]
}

export interface OcrProvidersBridgeOptions {
  /**
   * How to dynamic-import a plugin entry file. Defaults to `import()`;
   * tests inject a fake to keep the bridge hermetic.
   */
  importer?: (entry: string) => Promise<Record<string, unknown>>
  /**
   * How to resolve the plugin install root to an absolute path. The bridge
   * concatenates `installRoot + "/" + entry` before passing to `importer`.
   * Defaults to identity (returns the plugin path verbatim).
   */
  resolveInstallRoot?: (pluginId: string) => string
  /**
   * Plugin-scoped config / secret accessors handed to the factory.
   */
  getConfig?: (pluginId: string, key: string) => unknown
  getSecret?: (pluginId: string, key: string) => Promise<string | undefined>
}

const DEFAULT_IMPORTER: NonNullable<OcrProvidersBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

/**
 * Register every OCR provider declared in `manifest.ocrProviders[]` for
 * the given plugin. Idempotent at the plugin-id level — a second call for
 * the same plugin first clears prior registrations.
 */
export async function registerOcrProvidersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: OcrProvidersBridgeOptions = {}
): Promise<OcrProvidersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.ocrProviders ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior state so re-enable doesn't fight with the duplicate guard.
  clearOcrProvidersForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const ocrApi = createOcrAPI(pluginId)
  const errors: OcrProvidersBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      const provider = await resolveProvider(def, pluginId, installRoot, importer, options)
      ocrApi.registerProvider(provider)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, providerId: def.id, message })
      loggers.manager.error(`[ocr-bridge] failed to register ${pluginId}:${def.id}`, err)
    }
  }

  return { registered, errors }
}

async function resolveProvider(
  def: PluginOcrProviderDef,
  pluginId: string,
  installRoot: string,
  importer: NonNullable<OcrProvidersBridgeOptions["importer"]>,
  options: OcrProvidersBridgeOptions
): Promise<OcrProvider> {
  // `manifest.ocrProviders[].entry` is a relative path validated at manifest
  // load time (`lib/plugin/core/validation.ts`). We resolve it against the
  // plugin install root before importing.
  const resolved = `${installRoot.replace(/[\\/]+$/, "")}/${def.entry.replace(/^[\\/]+/, "")}`
  const mod = await importer(resolved)
  const exported = mod[def.export]
  if (typeof exported !== "function") {
    throw new Error(
      `entry "${def.entry}" does not export a factory named "${def.export}" (got ${typeof exported})`
    )
  }
  const factory = exported as PluginOcrProviderFactory
  const ctx = {
    providerId: `${pluginId}:${def.id}`,
    pluginId,
    getConfig: <T = unknown>(key: string) => options.getConfig?.(pluginId, key) as T | undefined,
    getSecret: (key: string) => Promise.resolve(options.getSecret?.(pluginId, key) ?? undefined),
  }
  const provider = await factory(ctx)
  if (!provider || typeof provider.extract !== "function") {
    throw new Error(`factory "${def.export}" returned an invalid OcrProvider`)
  }
  // The factory may name its provider whatever; the api wrapper rewrites
  // `id` to the prefixed form, but pre-condition it here so the inner
  // registry uniqueness check works on the un-prefixed key.
  return { ...provider, id: def.id }
}

/**
 * Plugin-disable hook — drop every provider this plugin contributed.
 */
export function unregisterOcrProvidersForPlugin(pluginId: string): void {
  clearOcrProvidersForPlugin(pluginId)
}
