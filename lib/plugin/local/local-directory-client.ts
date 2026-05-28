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
 * Build a one-shot client bound to `sourceDir`. Each call returns a
 * fresh client because the chain caches nothing across runs and the
 * user can re-pick a different directory between attempts.
 */
export function createLocalDirectoryClient(sourceDir: string): {
  getPlugin: (id: string) => Promise<{ manifest: PluginManifest; name?: string } | null>
  installPlugin: (id: string, version?: string) => Promise<unknown>
} {
  let cachedManifest: PluginManifest | null = null
  return {
    async getPlugin(_id: string) {
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
      const receipt = await installPluginFromDirectory(sourceDir, { pluginName })
      return receipt
    },
  }
}
