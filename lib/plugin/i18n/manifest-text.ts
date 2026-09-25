/**
 * A plugin's own name and description in the user's language.
 *
 * `resolvePluginLabel` reads the merged plugin i18n registry, which holds a
 * plugin's bundle only while it is enabled — right for contribution labels,
 * wrong for the Library and Discover lists, which mostly show plugins that are
 * not. These fields resolve from the manifest's own `i18n.locales` instead:
 * the user's locale, then English, then the literal `name` / `description`.
 */

import type { PluginManifest } from "@/types/plugin"

type ManifestText = Pick<
  PluginManifest,
  "name" | "description" | "nameKey" | "descriptionKey" | "i18n"
>

function lookup(
  manifest: ManifestText,
  key: string | undefined,
  locale: string
): string | undefined {
  if (!key) return undefined
  const locales = manifest.i18n?.locales
  if (!locales) return undefined
  const value = locales[locale]?.[key] ?? locales.en?.[key]
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/** The plugin's display name for `locale`. */
export function localizedPluginName(manifest: ManifestText, locale: string): string {
  return lookup(manifest, manifest.nameKey, locale) ?? manifest.name
}

/** The plugin's description for `locale`. */
export function localizedPluginDescription(manifest: ManifestText, locale: string): string {
  return lookup(manifest, manifest.descriptionKey, locale) ?? manifest.description
}
