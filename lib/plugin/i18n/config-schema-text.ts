/**
 * A plugin's `configSchema` labels in the user's language.
 *
 * The configuration form renders `title`, `description`, `markdownDescription`,
 * `patternMessage`, `deprecationMessage`, enum option labels and enum
 * descriptions straight from the manifest — plugin-authored text with no host
 * translation. Like `nameKey` / `descriptionKey` (`manifest-text.ts`), each of
 * those can now name a key in the manifest's OWN `i18n.locales` bundle:
 *
 *   `titleKey`, `descriptionKey`, `markdownDescriptionKey`, `patternMessageKey`,
 *   `deprecationMessageKey`, `enumItemLabelKeys[]`, `enumDescriptionKeys[]`
 *
 * Resolution is the user's locale, then English, then the literal field. The
 * manifest bundle is used (not the merged runtime registry) because the form is
 * also shown before install and for disabled plugins, when no runtime bundle is
 * loaded. Pure: returns a new schema and never mutates its input.
 */

import type { PluginManifest } from "@/types/plugin"

type LocaleBundles = NonNullable<PluginManifest["i18n"]>["locales"] | undefined

/** Scalar literal ← key pairs this module localizes on every property. */
const SCALAR_FIELDS = [
  ["title", "titleKey"],
  ["description", "descriptionKey"],
  ["markdownDescription", "markdownDescriptionKey"],
  ["patternMessage", "patternMessageKey"],
  ["deprecationMessage", "deprecationMessageKey"],
] as const

/** Array literal ← key-array pairs (one entry per `enum` value). */
const ARRAY_FIELDS = [
  ["enumItemLabels", "enumItemLabelKeys"],
  ["enumDescriptions", "enumDescriptionKeys"],
] as const

function lookup(locales: LocaleBundles, key: unknown, locale: string): string | undefined {
  if (typeof key !== "string" || key.length === 0 || !locales) return undefined
  // An empty translation is a gap, not a value: fall through to English.
  for (const candidate of [locales[locale]?.[key], locales.en?.[key]]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate
  }
  return undefined
}

/** UI text: user's locale, then English, then the model-facing literal. */
export function resolvePluginI18nText(
  literal: string,
  key: unknown,
  i18n: PluginManifest["i18n"] | undefined,
  locale: string
): string {
  return lookup(i18n?.locales, key, locale) ?? literal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function localizeProperty(
  prop: Record<string, unknown>,
  locales: LocaleBundles,
  locale: string
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prop }
  for (const [literal, keyField] of SCALAR_FIELDS) {
    const text = lookup(locales, prop[keyField], locale)
    if (text !== undefined) out[literal] = text
  }
  for (const [literal, keyField] of ARRAY_FIELDS) {
    const keys = prop[keyField]
    if (!Array.isArray(keys)) continue
    const fallback = Array.isArray(prop[literal]) ? (prop[literal] as unknown[]) : []
    out[literal] = keys.map((key, index) => lookup(locales, key, locale) ?? fallback[index])
  }
  if (isRecord(prop.items)) out.items = localizeProperty(prop.items, locales, locale)
  if (isRecord(prop.properties)) {
    out.properties = localizeProperties(prop.properties, locales, locale)
  }
  if (Array.isArray(prop.oneOf)) {
    out.oneOf = prop.oneOf.map((variant) =>
      isRecord(variant) ? localizeProperty(variant, locales, locale) : variant
    )
  }
  return out
}

function localizeProperties(
  properties: Record<string, unknown>,
  locales: LocaleBundles,
  locale: string
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      isRecord(value) ? localizeProperty(value, locales, locale) : value,
    ])
  )
}

/**
 * Resolve every `*Key` in a plugin config schema against the manifest's own
 * locale bundles. A schema that is not an object is returned unchanged.
 */
export function localizeConfigSchema(
  schema: unknown,
  i18n: PluginManifest["i18n"] | undefined,
  locale: string
): unknown {
  if (!isRecord(schema)) return schema
  const locales = i18n?.locales
  const out: Record<string, unknown> = { ...schema }
  if (isRecord(schema.properties)) {
    out.properties = localizeProperties(schema.properties, locales, locale)
  }
  return out
}

/**
 * Every plugin i18n key a config schema references, with the field path that
 * references it — for manifest validation (each must exist in every locale).
 */
export function collectConfigSchemaI18nKeys(
  schema: unknown
): Array<{ field: string; key: unknown }> {
  const found: Array<{ field: string; key: unknown }> = []
  const walk = (prop: unknown, path: string) => {
    if (!isRecord(prop)) return
    for (const [, keyField] of SCALAR_FIELDS) {
      if (prop[keyField] !== undefined)
        found.push({ field: `${path}.${keyField}`, key: prop[keyField] })
    }
    for (const [, keyField] of ARRAY_FIELDS) {
      const keys = prop[keyField]
      if (Array.isArray(keys)) {
        keys.forEach((key, index) => found.push({ field: `${path}.${keyField}[${index}]`, key }))
      }
    }
    if (isRecord(prop.items)) walk(prop.items, `${path}.items`)
    if (isRecord(prop.properties)) {
      for (const [key, value] of Object.entries(prop.properties))
        walk(value, `${path}.properties.${key}`)
    }
    if (Array.isArray(prop.oneOf)) {
      prop.oneOf.forEach((variant, index) => walk(variant, `${path}.oneOf[${index}]`))
    }
  }
  if (isRecord(schema) && isRecord(schema.properties)) {
    for (const [key, value] of Object.entries(schema.properties)) {
      walk(value, `configSchema.properties.${key}`)
    }
  }
  return found
}
