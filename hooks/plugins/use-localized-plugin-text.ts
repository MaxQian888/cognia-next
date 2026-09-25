"use client"

/**
 * A plugin's name and description in the user's language, for any surface
 * that holds its row or manifest — Library rows, cards, the detail header,
 * prompts. Resolved from the manifest's own `i18n.locales` through
 * `nameKey` / `descriptionKey` (`lib/plugin/i18n/manifest-text.ts`), so it
 * works for a plugin that is not enabled, whose bundle is not registered.
 */

import { useMemo } from "react"
import { useLocale } from "next-intl"

import { localizedPluginDescription, localizedPluginName } from "@/lib/plugin/i18n/manifest-text"
import type { PluginManifest } from "@/types/plugin"

type ManifestLike = Partial<
  Pick<PluginManifest, "name" | "description" | "nameKey" | "descriptionKey" | "i18n">
>

export interface LocalizedPluginText {
  name: string
  description: string
}

/** Pure form, for non-React callers (toasts built outside render, tests). */
export function localizePluginText(
  input: { name?: string; description?: string; manifest?: unknown },
  locale: string
): LocalizedPluginText {
  const manifest = (input.manifest ?? {}) as ManifestLike
  const base = {
    name: input.name || manifest.name || "",
    description: input.description ?? manifest.description ?? "",
    nameKey: manifest.nameKey,
    descriptionKey: manifest.descriptionKey,
    i18n: manifest.i18n,
  }
  return {
    name: localizedPluginName(base, locale),
    description: localizedPluginDescription(base, locale),
  }
}

export function useLocalizedPluginText(input: {
  name?: string
  description?: string
  manifest?: unknown
}): LocalizedPluginText {
  const locale = useLocale()
  const { name, description, manifest } = input
  return useMemo(
    () => localizePluginText({ name, description, manifest }, locale),
    [name, description, manifest, locale]
  )
}
