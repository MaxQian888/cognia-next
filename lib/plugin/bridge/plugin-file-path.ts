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

/**
 * Browser built-ins live in the JavaScript bundle, so their binary assets
 * cannot be read from the synthetic `builtin://` install root. Public assets
 * mirror the plugin directory under `/plugins/<pluginId>/`; segment encoding
 * keeps the returned URL loadable without relaxing the traversal guard.
 */
export function publicBuiltinAssetUrl(pluginId: string, relative: string): string {
  // `.` segments are dropped rather than encoded: VS Code manifests write
  // paths as `./dist/theme.json`, and the mirror URL must name the file itself.
  const encodedPath = relative
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .map(encodeURIComponent)
    .join("/")
  return `/plugins/${encodeURIComponent(pluginId)}/${encodedPath}`
}

/**
 * Read a text asset of a browser built-in from its public mirror.
 *
 * `builtin://<id>` is a synthetic install root with nothing behind it: the
 * browser `fetch` rejects the scheme outright, and on the desktop
 * `@tauri-apps/plugin-fs` has no file at that path either. The mirror under
 * `/plugins/<id>/` is part of the static export (`out/`), so the same
 * same-origin read works in the browser, in the Tauri webview (frontendDist)
 * and in the Capacitor webview (webDir) alike. The URL is always scoped to the
 * caller's own plugin id, so a built-in cannot read another plugin's mirror.
 */
async function readPublicBuiltinText(pluginId: string, relative: string): Promise<string> {
  const url = publicBuiltinAssetUrl(pluginId, relative)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} reading built-in plugin asset ${url}`)
  }
  return response.text()
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
  if (baseDir.startsWith("builtin://")) {
    return readPublicBuiltinText(pluginId, relative)
  }
  // No `builtin://` re-check: the early return above already took that branch.
  if (isTauri()) {
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
  if (baseDir.startsWith("builtin://")) {
    return publicBuiltinAssetUrl(pluginId, relative)
  }
  // No `builtin://` re-check: the early return above already took that branch.
  if (isTauri()) {
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
