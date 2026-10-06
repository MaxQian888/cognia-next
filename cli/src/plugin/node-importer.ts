/**
 * Installed frontend plugins use the same CJS bundle contract and host-shared
 * modules as the desktop loader. Read and evaluate each load so replaced bytes
 * are never hidden by Node's CommonJS cache. Native ESM / TypeScript imports
 * remain available for the source-development path.
 */
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { pathToFileURL } from "node:url"
import { evaluatePluginBundle } from "@/lib/plugin/core/evaluate-plugin-bundle"
import { primeSharedModulesFor } from "@/lib/plugin/core/shared-modules"

export interface NodeFrontendImporter {
  (absPath: string, pluginId: string): Promise<Record<string, unknown>>
  /** Increment a plugin's cache-bust generation so the next import re-executes. */
  bumpGeneration(pluginId: string): void
}

type DynamicImport = (spec: string) => Promise<Record<string, unknown>>

export function makeNodeFrontendImporter(dynamicImport?: DynamicImport): NodeFrontendImporter {
  const generation = new Map<string, number>()
  const importer = (async (absPath: string, pluginId: string) => {
    if (!dynamicImport && ![".mjs", ".mts", ".ts", ".tsx"].includes(extname(absPath))) {
      const code = await readFile(absPath, "utf8")
      await primeSharedModulesFor(code)
      return evaluatePluginBundle(code, absPath)
    }
    const gen = (generation.get(pluginId) ?? 0) + 1
    generation.set(pluginId, gen)
    const url = `${pathToFileURL(absPath).href}?v=${gen}`
    return dynamicImport ? dynamicImport(url) : import(url)
  }) as NodeFrontendImporter
  importer.bumpGeneration = (pluginId: string) => {
    generation.set(pluginId, (generation.get(pluginId) ?? 0) + 1)
  }
  return importer
}
