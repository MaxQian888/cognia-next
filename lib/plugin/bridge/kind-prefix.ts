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
