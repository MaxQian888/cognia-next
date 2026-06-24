/**
 * Translate a workflow node catalog string with a graceful fallback.
 *
 * Built-in nodes (kind = `trigger.cron`, `action.character.send`, …) have
 * `workflows.nodes.<kind>.label` / `.description` entries in the host message
 * bundle.
 *
 * Plugin-contributed nodes carry no host keys — but a plugin CAN ship its own
 * translations via `manifest.i18n.locales`, which the plugin manager registers
 * (and the `<LocaleGate>` overlay merges into next-intl) under the
 * `plugin.<pluginId>.` namespace. By convention a plugin localizes a node by
 * adding `workflow.nodes.<rawKind>.label` / `.description` keys, which resolve
 * at `plugin.<pluginId>.workflow.nodes.<rawKind>.<field>`. When the plugin
 * ships no such key the author's raw `label` / `description` stays as the
 * visible fallback.
 */

import { unprefixPluginKind } from "@/lib/plugin/bridge/kind-prefix"

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

/**
 * Build the merged-bundle key a plugin's node i18n strings resolve to.
 * `prefixedKind` is the namespaced catalog kind (`<pluginId>.<rawKind>` or
 * `trigger.<pluginId>.<rawKind>`); the returned key lives in the plugin's
 * own `plugin.<pluginId>.` overlay namespace.
 */
export function pluginNodeMessageKey(
  pluginId: string,
  prefixedKind: string,
  field: "label" | "description"
): string {
  const rawKind = unprefixPluginKind(pluginId, prefixedKind)
  return `plugin.${pluginId}.workflow.nodes.${rawKind}.${field}`
}

/**
 * Resolve a node's localized `label` / `description` from a ROOT next-intl
 * translator (`useTranslations()` with no namespace). Built-in kinds resolve
 * under `workflows.nodes.<kind>`; plugin kinds (those with a `pluginId`)
 * resolve under their `plugin.<pluginId>.workflow.nodes.<rawKind>` overlay.
 * Either way the catalog/author `fallback` shows when no key is registered.
 */
export function tNodeField(
  rootT: Translator,
  opts: { kind: string; pluginId?: string; field: "label" | "description"; fallback: string }
): string {
  const { kind, pluginId, field, fallback } = opts
  const key = pluginId
    ? pluginNodeMessageKey(pluginId, kind, field)
    : `workflows.nodes.${kind}.${field}`
  return tNode(rootT, key, fallback)
}
