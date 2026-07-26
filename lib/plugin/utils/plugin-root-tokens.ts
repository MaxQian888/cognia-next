/**
 * Canonical plugin-root token handling shared by converted plugin surfaces.
 *
 * Cognia stores `${COGNIA_PLUGIN_ROOT}` in its canonical manifest. Importers
 * also accept the equivalent source-ecosystem spellings so the original
 * skill and agent files can remain byte-for-byte intact. At registration or
 * skill-resolution time every supported spelling is bound to the installed
 * plugin directory.
 */

const PLUGIN_ROOT_TOKENS = [
  "${COGNIA_PLUGIN_ROOT}",
  "${CLAUDE_PLUGIN_ROOT}",
  "${CODEX_PLUGIN_ROOT}",
  "${extensionPath}",
] as const

export function replacePluginRootTokens<T>(value: T, pluginRoot: string): T {
  if (!pluginRoot) return value
  if (typeof value === "string") {
    let replaced: string = value
    for (const token of PLUGIN_ROOT_TOKENS) {
      replaced = replaced.replaceAll(token, pluginRoot)
    }
    return replaced as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePluginRootTokens(item, pluginRoot)) as T
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replacePluginRootTokens(item, pluginRoot)])
    ) as T
  }
  return value
}
