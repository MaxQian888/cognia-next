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
 *
 * A node whose inspector form is drawn from its `paramsSchema` localizes each
 * field the same way, under `fields.<field>.label` / `.description` /
 * `.options.<value>` beside the node's own keys (`nodeSchemaMessages`).
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

/** The part of a params-schema field the inspector form shows. */
export type NodeSchemaFieldPart =
  { part: "label" } | { part: "description" } | { part: "option"; value: string }

/** A message key segment: no `.`, which next-intl reads as nesting. */
function isKeySegment(segment: string): boolean {
  return segment.length > 0 && !segment.includes(".")
}

/**
 * The key a node's params-schema field text resolves at, beside the node's own
 * `label` / `description`: `…nodes.<kind>.fields.<field>.label`, `.description`
 * or `.options.<value>`, with a nested object's fields under its own
 * `fields`. Undefined when a segment cannot be a key (an option value with a
 * `.`), so the schema's own text shows.
 */
export function nodeSchemaFieldMessageKey(opts: {
  kind: string
  pluginId?: string
  path: readonly string[]
  field: NodeSchemaFieldPart
}): string | undefined {
  const { kind, pluginId, path, field } = opts
  if (path.length === 0 || !path.every(isKeySegment)) return undefined
  const node = pluginId
    ? `plugin.${pluginId}.workflow.nodes.${unprefixPluginKind(pluginId, kind)}`
    : `workflows.nodes.${kind}`
  const base = `${node}.${path.map((segment) => `fields.${segment}`).join(".")}`
  if (field.part !== "option") return `${base}.${field.part}`
  return isKeySegment(field.value) ? `${base}.options.${field.value}` : undefined
}

/**
 * Localized text for a node's params-schema form: each resolver returns the
 * registered translation, or undefined so the form keeps the schema's text.
 */
export interface NodeSchemaMessages {
  label(path: readonly string[]): string | undefined
  description(path: readonly string[]): string | undefined
  option(path: readonly string[], value: string): string | undefined
}

/** {@link NodeSchemaMessages} for one node kind, from a ROOT translator. */
export function nodeSchemaMessages(
  rootT: Translator,
  node: { kind: string; pluginId?: string }
): NodeSchemaMessages {
  const resolve = (path: readonly string[], field: NodeSchemaFieldPart) => {
    const key = nodeSchemaFieldMessageKey({ ...node, path, field })
    if (!key) return undefined
    const text = tNode(rootT, key, "")
    return text === "" ? undefined : text
  }
  return {
    label: (path) => resolve(path, { part: "label" }),
    description: (path) => resolve(path, { part: "description" }),
    option: (path, value) => resolve(path, { part: "option", value }),
  }
}
