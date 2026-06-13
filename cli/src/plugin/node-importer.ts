/**
 * Node frontend-plugin importer. The shared loader's `importModule` uses
 * Tauri/fetch/eval strategies that don't exist under Node; this importer loads
 * a plugin's `main` bundle via dynamic `import()` of a `file://` URL, with a
 * per-plugin cache-busting `?v=N` query so `/plugin reload` re-executes the
 * module instead of returning the ESM-cached copy.
 *
 * The plugin `main` must be runnable JS (no `@/` aliases) — the same constraint
 * `discover-plugins` already implies for CLI-"supported" plugins.
 */
import { pathToFileURL } from "node:url"

export interface NodeFrontendImporter {
  (absPath: string, pluginId: string): Promise<Record<string, unknown>>
  /** Increment a plugin's cache-bust generation so the next import re-executes. */
  bumpGeneration(pluginId: string): void
}

type DynamicImport = (spec: string) => Promise<Record<string, unknown>>

export function makeNodeFrontendImporter(
  dynamicImport: DynamicImport = (spec) => import(spec)
): NodeFrontendImporter {
  const generation = new Map<string, number>()
  const importer = (async (absPath: string, pluginId: string) => {
    const gen = (generation.get(pluginId) ?? 0) + 1
    generation.set(pluginId, gen)
    const url = `${pathToFileURL(absPath).href}?v=${gen}`
    return dynamicImport(url)
  }) as NodeFrontendImporter
  importer.bumpGeneration = (pluginId: string) => {
    generation.set(pluginId, (generation.get(pluginId) ?? 0) + 1)
  }
  return importer
}
