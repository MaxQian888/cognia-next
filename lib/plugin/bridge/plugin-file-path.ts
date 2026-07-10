/**
 * Shared path guards for bridges that read plugin-contributed files at
 * enable time (themes, grammars, icon themes, snippets). Extracted from
 * themes-bridge (W5.1) so every asset bridge applies the same traversal
 * defense.
 */

/**
 * Reject relative paths that try to escape the plugin root.
 * Allowed: relative subpaths like `syntaxes/foo.json` or `./foo.json`.
 * Blocked: `..` segments, leading `/`, leading `\`, drive letters.
 */
export function isUnsafeRelativePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return true
  // Drive letter (Windows) or POSIX absolute.
  if (/^([A-Za-z]:)?[\\/]/.test(path)) return true
  // Any `..` segment after splitting on either separator.
  const segments = path.split(/[\\/]+/)
  return segments.some((seg) => seg === "..")
}

export function joinPluginPath(baseDir: string, relative: string): string {
  if (baseDir.endsWith("/") || baseDir.endsWith("\\")) {
    return baseDir + relative
  }
  // Use `/` — Tauri's plugin-fs accepts both separators on Windows.
  return `${baseDir}/${relative}`
}
