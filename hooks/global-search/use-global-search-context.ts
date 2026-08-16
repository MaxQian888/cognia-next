"use client"

/**
 * Assemble the `GlobalSearchContext` from React state (ADR-0129).
 *
 * Everything providers need that lives behind a hook — the cross-workspace
 * session list, the project store, theme, settings reachability, plugin quick
 * actions filtered for the palette surface, the active workbench's panels —
 * is read here once and handed to the engine as plain data. Providers stay
 * store-free; this hook is the only place that knows where each fact lives.
 */

import { useTheme } from "next-themes"
import { useLocale, useNow, useTranslations } from "next-intl"
import { useMemo, useSyncExternalStore } from "react"
import type { ChatSession } from "@cognia/agent-config-types"

import { usePluginQuickActions } from "@/hooks/plugins/use-plugin-quick-actions"
import { useSettingsSectionReachability } from "@/hooks/settings/use-settings-section-reachability"
import { useRecorderAvailable } from "@/hooks/skills/use-skill-recorder"
import { usePlatform } from "@/hooks/use-platform"
import {
  getActiveContextRevision,
  getActiveWorkbenchPanels,
  subscribeActiveContext,
} from "@/lib/context-workbench/active-context"
import type { GlobalSearchContext, GlobalSearchScope } from "@/lib/global-search/types"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

export interface UseGlobalSearchContextOptions {
  sessions: readonly ChatSession[]
  scope: GlobalSearchScope
}

type RootTranslator = ReturnType<typeof useTranslations> & {
  has?: (key: string) => boolean
}

/**
 * Resolve a workbench panel's label. Plugin panels namespace their key under
 * `plugin.<id>.*`; when the plugin shipped no translation the raw label wins.
 */
export function resolvePanelLabel(
  panel: { labelKey: string; label?: string; pluginId?: string },
  t: RootTranslator
): string {
  if (!panel.pluginId) return t(panel.labelKey as never)
  const key = `plugin.${panel.pluginId}.${panel.labelKey}`
  return typeof t.has === "function" && t.has(key)
    ? t(key as never)
    : (panel.label ?? panel.labelKey)
}

export function useGlobalSearchContext({
  sessions,
  scope,
}: UseGlobalSearchContextOptions): GlobalSearchContext {
  const t = useTranslations() as RootTranslator
  const locale = useLocale()
  const platform = usePlatform()
  const { theme } = useTheme()
  const { sections } = useSettingsSectionReachability()
  const recorderAvailable = useRecorderAvailable()
  const pluginQuickActions = usePluginQuickActions("palette")
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const workspaces = useProjectStore((s) => s.projects)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasApiKey = useSettingsStore((s) => Boolean(s.settings?.apiKey))
  // A stable "now" per mount (no update interval) — recency scoring does not
  // need to tick, and reading the clock during render would be impure.
  const now = useNow()

  // Revision counter as the snapshot — the panel accessor returns fresh clones
  // which React would reject as an uncached snapshot (see the old palette).
  const panelRevision = useSyncExternalStore(
    subscribeActiveContext,
    getActiveContextRevision,
    () => 0
  )
  const workbenchPanels = useMemo(
    () =>
      getActiveWorkbenchPanels().map((panel) => ({
        id: panel.id,
        label: resolvePanelLabel(panel, t),
        activity: panel.activity,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panelRevision is the subscription key
    [panelRevision, t]
  )

  return useMemo<GlobalSearchContext>(
    () => ({
      t: (key, values) => t(key as never, values as never),
      locale,
      platform,
      isTauri: isTauri(),
      now: now.getTime(),
      activeProjectId: activeProjectId ?? null,
      activeSessionId: activeSessionId ?? null,
      sessions,
      workspaces,
      scope,
      host: {
        reachableSettingsSections: sections as ReadonlySet<string>,
        recorderAvailable,
        theme,
        hasApiKey,
        pluginQuickActions,
        workbenchPanels,
      },
    }),
    [
      t,
      locale,
      platform,
      now,
      activeProjectId,
      activeSessionId,
      sessions,
      workspaces,
      scope,
      sections,
      recorderAvailable,
      theme,
      hasApiKey,
      pluginQuickActions,
      workbenchPanels,
    ]
  )
}
