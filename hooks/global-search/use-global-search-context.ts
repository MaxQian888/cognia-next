"use client"

/**
 * Assemble the `GlobalSearchContext` from React state (ADR-0129).
 *
 * Everything providers need that lives behind a hook — the cross-workspace
 * session list, the project store, theme, settings reachability, plugin quick
 * actions filtered for the palette surface, the active workbench's panels, the
 * navigation rail's layout as seen from the route in front —
 * is read here once and handed to the engine as plain data. Providers stay
 * store-free; this hook is the only place that knows where each fact lives.
 */

import { useTheme } from "next-themes"
import { useLocale, useNow, useTranslations } from "next-intl"
import { usePathname } from "next/navigation"
import { useMemo, useSyncExternalStore } from "react"
import type { ChatSession } from "@cognia/agent-config-types"

import { useSidebarLayout } from "@/components/shell/use-sidebar-layout"
import { usePluginQuickActions } from "@/hooks/plugins/use-plugin-quick-actions"
import { useSettingsSectionReachability } from "@/hooks/settings/use-settings-section-reachability"
import { useRecorderAvailable } from "@/hooks/skills/use-skill-recorder"
import { usePlatform } from "@/hooks/use-platform"
import { useWorkspaceCommandGate } from "@/hooks/workspace/use-workspace-command-gate"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import {
  getActiveContextRevision,
  getActiveWorkbenchPanels,
  subscribeActiveContext,
} from "@/lib/context-workbench/active-context"
import type {
  GlobalSearchContext,
  GlobalSearchScope,
  GlobalSearchShellNav,
} from "@/lib/global-search/types"
import { isPetAvailable } from "@/lib/pet/access/availability"
import {
  PET_REMOTE_CARE_OPERATION,
  hostAdvertisesPetRemoteCare,
} from "@/lib/pet/console/console-mode"
import { useActiveHostSupportsFeature } from "@/stores/remote-host/remote-host-store"
import { getPetWindowRole } from "@/lib/pet/window-role"
import { navItemForPath } from "@/lib/shell/sidebar-nav"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"

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
  const runtimeSnapshot = useRuntimeSnapshot()
  const { theme } = useTheme()
  const { sections } = useSettingsSectionReachability()
  const recorderAvailable = useRecorderAvailable()
  // The structural question only (host + window role): summoning the pet from
  // the palette switches it on, so its current setting must not hide the way.
  const petHostAvailable = useMemo(
    () => isPetAvailable({ enabled: true, role: getPetWindowRole(), platform }),
    [platform]
  )
  // The console also opens where it can care for a paired desktop's pet
  // (ADR-0219): the companion's host, or the remote host this desktop drives.
  const remoteHostHasPet = useActiveHostSupportsFeature(
    "pet.remote-care",
    PET_REMOTE_CARE_OPERATION
  )
  const petConsoleReachable =
    petHostAvailable || remoteHostHasPet || hostAdvertisesPetRemoteCare(runtimeSnapshot)
  const workspaceDirGate = useWorkspaceCommandGate()
  const pluginQuickActions = usePluginQuickActions("palette")
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // Which skills this workspace actually loads. Search demotes rather than
  // hides the rest — see `lib/global-search/workspace-scope.ts`.
  const capabilityOverlay = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.capabilityOverlay
  )
  const workspaces = useProjectStore((s) => s.projects)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasApiKey = useSettingsStore((s) => Boolean(s.settings?.apiKey))
  // The rail as it resolves right now, for the navigation-customization
  // commands: the same layout hook the rail draws from, so a page the palette
  // calls pinned is the one the rail shows pinned.
  const pathname = usePathname()
  const { catalog, resolved, side } = useSidebarLayout()
  const railCollapsed = useUIStore((s) => s.guildRailCollapsed)
  const shellNav = useMemo<GlobalSearchShellNav>(() => {
    const page = navItemForPath(pathname ?? "", catalog)
    return {
      currentPage: page ? { id: page.id, i18nKey: page.i18nKey } : null,
      currentPinned: page ? resolved.pinned.some((item) => item.id === page.id) : false,
      currentHidden: page ? resolved.hidden.some((item) => item.id === page.id) : false,
      railCollapsed,
      side,
      // The mobile drawer draws the rail but never folds or moves it.
      railChrome: platform !== "mobile",
    }
  }, [pathname, catalog, resolved, side, railCollapsed, platform])
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
      runtimeSnapshot,
      sessions,
      workspaces,
      capabilityOverlay,
      scope,
      host: {
        reachableSettingsSections: sections as ReadonlySet<string>,
        recorderAvailable,
        petHostAvailable,
        petConsoleReachable,
        theme,
        hasApiKey,
        pluginQuickActions,
        workbenchPanels,
        // Same rule the workspace switcher applies, read from the same gate.
        canBrowseHostFolders: isTauri() || workspaceDirGate("fs_list_workspace_dir").available,
        shellNav,
      },
    }),
    [
      t,
      locale,
      platform,
      now,
      activeProjectId,
      activeSessionId,
      runtimeSnapshot,
      sessions,
      workspaces,
      capabilityOverlay,
      scope,
      sections,
      recorderAvailable,
      petHostAvailable,
      petConsoleReachable,
      workspaceDirGate,
      theme,
      hasApiKey,
      pluginQuickActions,
      workbenchPanels,
      shellNav,
    ]
  )
}
