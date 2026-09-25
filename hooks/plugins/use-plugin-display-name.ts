"use client"

/**
 * A plugin's human name for prompts that only carry its id.
 *
 * Consent and permission requests arrive as `{ pluginId, permission }` from
 * the broker and the request queue, and both prompts printed the id
 * (`com.example.web-tools`) as the thing asking for access. The runtime store
 * already holds every loaded plugin's manifest, so the name is one selector
 * away. Falls back to the id for a plugin the store does not (yet) know, which
 * is still the honest answer to "who is asking".
 */

import { useLocale } from "next-intl"

import { localizedPluginName } from "@/lib/plugin/i18n/manifest-text"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

export function usePluginDisplayName(pluginId: string | null | undefined): string {
  const locale = useLocale()
  const manifest = usePluginStore((state) =>
    pluginId ? state.plugins[pluginId]?.manifest : undefined
  )
  // The manifest's own localized name (`nameKey`) when it has one.
  const name = manifest ? localizedPluginName(manifest, locale) : undefined
  const trimmed = typeof name === "string" ? name.trim() : ""
  return trimmed || pluginId || ""
}
