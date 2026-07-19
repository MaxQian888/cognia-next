/**
 * Cross-runtime asset/path helpers shared by the module-bridge capabilities
 * (`lib/plugin/contracts/module-bridge-map.ts`).
 *
 * Two distinct needs:
 *   - Asset bridges resolve relative paths to browser-loadable URLs. Tauri
 *     reads bytes through the native no-follow boundary and returns a data URL;
 *     web/test runtimes keep the validated joined URL.
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
 * A `(pluginRoot, relPath) => url` resolver shared by asset bridges. Native
 * reads are asynchronous because the host consumes the file through its
 * contained, no-follow boundary.
 */
export type PluginAssetResolver = (
  pluginRoot: string,
  relPath: string,
  mime?: string
) => string | Promise<string>

/**
 * Build the asset resolver for the current runtime. Under Tauri, the returned
 * closure requests bytes from the native contained-file command and returns a
 * data URL. Web, test, and SSR runtimes retain the validated joined URL.
 */
export async function createPluginAssetResolver(pluginId: string): Promise<PluginAssetResolver> {
  const { readContainedPluginAsset } = await import("@/lib/plugin/bridge/plugin-file-path")
  return (root, rel, mime) => readContainedPluginAsset(pluginId, root, rel, mime)
}
