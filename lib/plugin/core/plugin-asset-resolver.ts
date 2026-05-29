/**
 * Cross-runtime asset/path helpers shared by the module-bridge capabilities
 * (`lib/plugin/contracts/module-bridge-map.ts`).
 *
 * Two distinct needs:
 *   - Some bridges (fonts, wallpapers) call a SYNC `resolveAsset(root, rel)`
 *     to turn a relative bundled-asset path into a browser-loadable URL.
 *     Under Tauri that means `convertFileSrc(absolutePath)`; in web/test it
 *     is the joined path verbatim. Because `@tauri-apps/api/core` loads
 *     asynchronously, `createPluginAssetResolver()` resolves the converter
 *     once (async) and hands back a sync closure the bridges can call freely.
 *   - The import-based bridges (ai/ocr/workspace/message-renderer) and the
 *     connectors bridge resolve JS entry modules via the PluginLoader's
 *     proven `importEntry` (Tauri asset-protocol → fetch+eval → script tag);
 *     they do not use this module's resolver — see `manager.ts` wiring.
 *
 * `joinPluginPath` is the single source for "install root + relative entry"
 * joining, replacing the inline duplicates previously scattered across the
 * individual bridges and `themes-bridge.ts`.
 */

/**
 * Join a plugin install root with a relative entry/asset path. Trims trailing
 * separators from the root and leading separators from the relative part so
 * the result has exactly one `/` at the seam. Mirrors the inline logic the
 * bridges previously hand-rolled.
 */
export function joinPluginPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`
}

/**
 * A synchronous `(pluginRoot, relPath) => url` resolver, matching the
 * signature the font/wallpaper bridges expect.
 */
export type PluginAssetResolver = (pluginRoot: string, relPath: string) => string

/**
 * Build the asset resolver for the current runtime. Under Tauri the returned
 * closure runs `convertFileSrc` over the joined absolute path; everywhere else
 * (web shell, tests, SSR) it returns the joined path unchanged. Resolving the
 * Tauri converter is async (dynamic module load), but the returned resolver is
 * synchronous so font/wallpaper bridges can call it inside tight loops.
 */
export async function createPluginAssetResolver(): Promise<PluginAssetResolver> {
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core")
    return (root, rel) => convertFileSrc(joinPluginPath(root, rel))
  } catch {
    // Not running under Tauri (web/test): the joined path is already a
    // browser-loadable URL relative to the served plugin assets.
    return (root, rel) => joinPluginPath(root, rel)
  }
}
