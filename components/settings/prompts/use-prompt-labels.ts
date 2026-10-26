"use client"

/**
 * Localized names for the Prompt Center's vocabulary and its catalog entries.
 *
 * Catalog ids are dotted (`generation.title.chat`) and next-intl reads a dot
 * as nesting, so each entry's messages live under the id with every `.`
 * turned into `__` (`settings.promptEntries.generation__title__chat`). A slot
 * a plugin registered carries the plugin's own title and description.
 */

import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { getPluginPromptEntry } from "@/lib/prompts/plugin-prompts"

export function promptEntryKey(id: string): string {
  return id.replaceAll(".", "__")
}

export function usePromptLabels() {
  const t = useTranslations("settings.promptCenter")
  const tEntries = useTranslations("settings.promptEntries")
  return useMemo(
    () => ({
      t,
      entryTitle: (id: string) => {
        const key = `${promptEntryKey(id)}.title`
        if (tEntries.has(key)) return tEntries(key)
        return getPluginPromptEntry(id)?.title ?? id
      },
      entryDescription: (id: string) => {
        const key = `${promptEntryKey(id)}.description`
        if (tEntries.has(key)) return tEntries(key)
        return getPluginPromptEntry(id)?.description ?? ""
      },
    }),
    [t, tEntries]
  )
}

export type PromptLabels = ReturnType<typeof usePromptLabels>
