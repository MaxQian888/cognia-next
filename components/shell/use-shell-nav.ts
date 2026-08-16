"use client"

/**
 * The shell's top-level navigation model — one hook behind two renderings.
 *
 * `GuildRail` (the 56px icon column) and the expanded sidebar's nav section
 * (`sidebar-nav-section.tsx`, rows with labels) show the same destinations:
 * the chat guilds (DM · Canvas · plugin view containers · teams), the pinned
 * feature routes, the "More" overflow, and the customization actions. Which
 * of the two is on screen is a layout choice (`sidebarHostsNav` in
 * `stores/ui/shell-columns-store.ts`); what they navigate to must not drift,
 * so the switch / active-state logic lives here and both call it.
 *
 * Log lines are stable strings — tests on both surfaces pin them.
 */

import { useCallback, useSyncExternalStore } from "react"
import { usePathname, useRouter } from "next/navigation"
import { loggers } from "@cognia/logging"
import { useUIStore } from "@/stores/ui"
import {
  getViewContainerSnapshot,
  subscribeViewContainers,
  type ViewContainerEntry,
} from "@/lib/plugin/registries/view-container-registry"
import {
  evaluateContextWhen,
  getContextKeyRevision,
  subscribeContextKeys,
} from "@/lib/plugin/context-keys/context-key-store"
import { useSidebarLayout, type UseSidebarLayout } from "./use-sidebar-layout"
import type { SelectedGuild } from "@/stores/ui"

const log = loggers.ui

export interface ShellNav {
  pathname: string
  /** `/` — the only route where a chat guild counts as "where you are". */
  onHomeRoute: boolean
  selected: SelectedGuild
  isDmActive: boolean
  isCanvasActive: boolean
  isTeamActive: (teamId: string) => boolean
  isViewContainerActive: (fullId: string) => boolean
  /** Route-prefix match, so `/inbox/123` lights the Inbox entry. */
  isFeatureActive: (route: string) => boolean
  /** True while the current route belongs to an item folded into "More". */
  overflowActive: boolean
  /** Plugin view containers that want a rail entry and pass their `when`. */
  railContainers: ViewContainerEntry[]
  layout: UseSidebarLayout
  switchToDm: () => void
  switchToCanvas: () => void
  switchToTeam: (teamId: string) => void
  switchToViewContainer: (containerId: string) => void
  goToFeature: (route: string) => void
}

export function useShellNav(): ShellNav {
  const router = useRouter()
  const pathname = usePathname() ?? "/"
  const selected = useUIStore((s) => s.selectedGuild)
  const setSelected = useUIStore((s) => s.setSelectedGuild)
  // Plugin-contributed view containers (B1). Re-render on registry mutation
  // and on context-key changes (the `when` filter reads the context store).
  const viewContainers = useSyncExternalStore(
    subscribeViewContainers,
    getViewContainerSnapshot,
    getViewContainerSnapshot
  )
  useSyncExternalStore(subscribeContextKeys, getContextKeyRevision, () => 0)
  const railContainers = viewContainers.filter(
    (c) => c.def.location !== "panel" && evaluateContextWhen(c.def.when)
  )
  const layout = useSidebarLayout()

  const onHomeRoute = pathname === "/"
  const isDmActive = onHomeRoute && selected.kind === "dm"
  const isCanvasActive = onHomeRoute && selected.kind === "canvas"
  const isTeamActive = useCallback(
    (teamId: string) => onHomeRoute && selected.kind === "team" && selected.teamId === teamId,
    [onHomeRoute, selected]
  )
  const isViewContainerActive = useCallback(
    (fullId: string) =>
      onHomeRoute && selected.kind === "plugin-view" && selected.containerId === fullId,
    [onHomeRoute, selected]
  )
  const isFeatureActive = useCallback(
    (route: string) => pathname === route || pathname.startsWith(route + "/"),
    [pathname]
  )
  const overflowActive = layout.resolved.overflow.some((item) => isFeatureActive(item.route))

  const goHome = useCallback(() => {
    if (!onHomeRoute) router.push("/")
  }, [onHomeRoute, router])

  const switchToDm = useCallback(() => {
    log.info("guild switch dm")
    setSelected({ kind: "dm" })
    goHome()
  }, [setSelected, goHome])
  const switchToCanvas = useCallback(() => {
    log.info("guild switch canvas")
    setSelected({ kind: "canvas" })
    goHome()
  }, [setSelected, goHome])
  const switchToTeam = useCallback(
    (teamId: string) => {
      log.info("guild switch team", { teamId })
      setSelected({ kind: "team", teamId })
      goHome()
    },
    [setSelected, goHome]
  )
  const switchToViewContainer = useCallback(
    (containerId: string) => {
      log.info("guild switch plugin-view", { containerId })
      setSelected({ kind: "plugin-view", containerId })
      goHome()
    },
    [setSelected, goHome]
  )
  const goToFeature = useCallback(
    (route: string) => {
      log.info("guild navigate feature", { route })
      router.push(route)
    },
    [router]
  )

  return {
    pathname,
    onHomeRoute,
    selected,
    isDmActive,
    isCanvasActive,
    isTeamActive,
    isViewContainerActive,
    isFeatureActive,
    overflowActive,
    railContainers,
    layout,
    switchToDm,
    switchToCanvas,
    switchToTeam,
    switchToViewContainer,
    goToFeature,
  }
}
