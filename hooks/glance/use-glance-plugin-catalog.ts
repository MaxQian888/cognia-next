"use client"

/**
 * The plugin modules running in this window, for one platform (ADR-0225 §6),
 * titles resolved in the user's language. For an editor that lives in the
 * window that runs plugins (the desktop settings page, a standalone phone);
 * the tray panel and a paired phone read the catalogue from their snapshot.
 */

import { useMemo, useSyncExternalStore } from "react"
import { useLocale, useTranslations } from "next-intl"

import { buildPluginsSlice } from "@/lib/glance/build-plugins"
import { glancePluginModules } from "@/lib/glance/plugin-registry"
import type { GlancePlatform } from "@/lib/glance/registry"
import type { GlancePluginCatalogEntry } from "@/lib/glance/snapshot"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"

export function useGlancePluginCatalog(platform: GlancePlatform): GlancePluginCatalogEntry[] {
  const t = useTranslations()
  const locale = useLocale()
  const version = useSyncExternalStore(
    glancePluginModules.subscribe,
    glancePluginModules.getVersion,
    glancePluginModules.getVersion
  )
  return useMemo(
    () =>
      buildPluginsSlice({
        catalog: glancePluginModules.catalog(),
        dataOf: () => null,
        visible: [],
        platform,
        resolveTitle: (entry) =>
          resolvePluginLabel(t, entry.pluginId, entry.def.titleKey, entry.def.title),
        now: 0,
      }).catalog,
    // `version` is the registry's change signal, `locale` the translator's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, platform, locale]
  )
}
