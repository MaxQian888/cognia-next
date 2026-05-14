/**
 * Translate a workflow node catalog string with a graceful fallback.
 *
 * Built-in nodes (kind = `trigger.cron`, `action.character.send`, …) have
 * `workflows.nodes.<kind>.label` / `.description` entries in the message
 * bundle. Plugin-contributed entries do not — the plugin author's English
 * `label` / `description` from the catalog stays as the visible fallback.
 */

// Typed loosely (function + optional `has`) so any next-intl namespace
// translator is accepted — the strict next-intl type's `values` second
// argument would otherwise reject narrower runtime shapes.
type Translator = ((key: string) => string) & { has?: (key: string) => boolean }

export function tNode(t: Translator, key: string, fallback: string): string {
  if (typeof t.has === "function" && !t.has(key)) {
    return fallback
  }
  try {
    return t(key)
  } catch {
    return fallback
  }
}
