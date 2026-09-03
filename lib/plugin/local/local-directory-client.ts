/**
 * `MarketplaceClient`-shaped adapter for on-disk plugin folders. The
 * pre-install chain in `lib/plugin/marketplace/install-flow.ts` was
 * written against a marketplace-fetch + Tauri-install pipeline; this
 * adapter lets the same chain run against a directory the user picked
 * locally so the conflict / permission / config dialogs and the
 * transactional rollback all stay shared with the marketplace path.
 *
 * The "plugin id" surfaced to the chain is the directory path itself —
 * the chain never needs the real manifest id until step 1 (`getPlugin`),
 * which we resolve by reading `plugin.json` from disk.
 */

import type { PluginManifest } from "@/types/plugin"
import {
  installPluginFromDirectory,
  previewLocalManifest,
} from "@/lib/plugin/local/install-from-directory"

/**
 * A conversion result to install instead of reading `plugin.json` from disk.
 *
 * Present when the picked directory holds a foreign bundle. The manifest is
 * the converted one, so the pre-install chain shows the permissions and
 * config of the plugin that will actually be installed rather than of a
 * `plugin.json` the source does not have.
 */
export interface LocalDirectoryConversion {
  manifest: PluginManifest
  generatedFiles: Record<string, string>
}

/**
 * Build a one-shot client bound to `sourceDir`. Each call returns a
 * fresh client because the chain caches nothing across runs and the
 * user can re-pick a different directory between attempts.
 */
export function createLocalDirectoryClient(
  sourceDir: string,
  conversion?: LocalDirectoryConversion
): {
  getPlugin: (id: string) => Promise<{ manifest: PluginManifest; name?: string } | null>
  installPlugin: (id: string, version?: string) => Promise<unknown>
} {
  let cachedManifest: PluginManifest | null = conversion?.manifest ?? null
  return {
    async getPlugin(_id: string) {
      // A converted bundle has no `plugin.json` on disk to read, and its
      // converted manifest is what the chain must gate on.
      if (conversion) return { manifest: conversion.manifest, name: conversion.manifest.name }
      try {
        const manifest = await previewLocalManifest(sourceDir)
        cachedManifest = manifest
        return { manifest, name: manifest.name }
      } catch {
        // Caller treats a null return as "plugin_not_found".
        return null
      }
    },
    async installPlugin(_id: string, _version?: string) {
      const pluginName = cachedManifest?.name
      const receipt = await installPluginFromDirectory(sourceDir, {
        pluginName,
        generatedFiles: conversion?.generatedFiles,
      })
      return receipt
    },
  }
}
