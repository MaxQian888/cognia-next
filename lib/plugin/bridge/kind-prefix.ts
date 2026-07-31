/**
 * Plugin kind prefixing — single source of truth for how
 * plugin-contributed workflow nodes / triggers / catalog entries are
 * namespaced under their owning pluginId.
 *
 * Triggers preserve the leading `trigger.` segment so the orchestrator's
 * pattern-match on the namespace still works; everything else just gets
 * prefixed flat.
 */

export function prefixPluginKind(pluginId: string, rawKind: string): string {
  if (rawKind.startsWith("trigger.")) {
    return `trigger.${pluginId}.${rawKind.slice("trigger.".length)}`
  }
  return `${pluginId}.${rawKind}`
}

/**
 * Inverse of `prefixPluginKind`: recover the raw kind a plugin originally
 * registered from its namespaced catalog kind. Used to derive the plugin's
 * own i18n key convention (`workflow.nodes.<rawKind>.*`) at render time.
 *
 * Returns the kind unchanged when it carries no matching prefix (e.g. a
 * built-in kind), so callers can pass any kind safely.
 */
export function unprefixPluginKind(pluginId: string, prefixedKind: string): string {
  const triggerPrefix = `trigger.${pluginId}.`
  if (prefixedKind.startsWith(triggerPrefix)) {
    return `trigger.${prefixedKind.slice(triggerPrefix.length)}`
  }
  const flatPrefix = `${pluginId}.`
  if (prefixedKind.startsWith(flatPrefix)) {
    return prefixedKind.slice(flatPrefix.length)
  }
  return prefixedKind
}
