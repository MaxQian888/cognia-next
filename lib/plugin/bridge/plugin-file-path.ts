/**
 * Shared path guards for bridges that read plugin-contributed files at
 * enable time (themes, grammars, icon themes, snippets). Extracted from
 * themes-bridge (W5.1) so every asset bridge applies the same traversal
 * defense.
 */

import { getPluginPathViolations, resolvePluginPath } from "@/lib/plugin/core/plugin-path"

/** Reject paths that cannot be confined to the plugin root. */
export function isUnsafeRelativePath(path: string): boolean {
  return getPluginPathViolations(path).length > 0
}

export function joinPluginPath(baseDir: string, relative: string): string {
  return resolvePluginPath(baseDir, relative)
}
