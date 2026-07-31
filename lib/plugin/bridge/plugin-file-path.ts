/**
 * Shared path guards for bridges that read plugin-contributed files at
 * enable time (themes, grammars, icon themes, snippets). Extracted from
 * themes-bridge (W5.1) so every asset bridge applies the same traversal
 * defense.
 */

import { getPluginPathViolations, resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import { readTextFile } from "@/lib/file/file-operations"
import { isTauri } from "@/lib/platform/detect"

/** Reject paths that cannot be confined to the plugin root. */
export function isUnsafeRelativePath(path: string): boolean {
  return getPluginPathViolations(path).length > 0
}

export function joinPluginPath(baseDir: string, relative: string): string {
  return resolvePluginPath(baseDir, relative)
}

/** Read a plugin-owned asset through the native no-follow boundary when available. */
export async function readContainedPluginFile(
  pluginId: string,
  baseDir: string,
  relative: string
): Promise<string> {
  if (isUnsafeRelativePath(relative)) {
    throw new Error(`unsafe plugin path "${relative}"`)
  }
  if (isTauri() && !baseDir.startsWith("builtin://")) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<string>("plugin_read_entry", {
      pluginId,
      pluginPath: baseDir,
      entry: relative,
    })
  }
  return readTextFile(joinPluginPath(baseDir, relative))
}

/** Resolve a binary asset through the same native no-follow read operation. */
export async function readContainedPluginAsset(
  pluginId: string,
  baseDir: string,
  relative: string,
  mime = "application/octet-stream"
): Promise<string> {
  if (isUnsafeRelativePath(relative)) {
    throw new Error(`unsafe plugin path "${relative}"`)
  }
  if (isTauri() && !baseDir.startsWith("builtin://")) {
    const { invoke } = await import("@tauri-apps/api/core")
    const base64 = await invoke<string>("plugin_read_entry_base64", {
      pluginId,
      pluginPath: baseDir,
      entry: relative,
    })
    return `data:${mime};base64,${base64}`
  }
  return joinPluginPath(baseDir, relative)
}
