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
 * The workspace modes — Canvas and the plugin view containers — are resolved
 * here too (`modes`), against `SidebarLayout.modes`: the plugin containers
 * come from a registry this hook already subscribes to, and both renderings
 * must agree on which modes are shown and in what order.
 *
 * Log lines are stable strings — tests on both surfaces pin them.
 */

import { useCallback, useMemo, useState, useSyncExternalStore, useTransition } from "react"
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
import { defaultModeOrder, resolveSidebarModes } from "@/lib/shell/sidebar-nav"
import type { ResolvedOrderedCatalog } from "@/lib/shell/layout-partition"
import { CANVAS_MODE_ID, type SidebarModesLayout } from "@/types/shell/sidebar"
import { useSidebarLayout, type UseSidebarLayout } from "./use-sidebar-layout"
import type { SelectedGuild } from "@/stores/ui"

const log = loggers.ui

/** One workspace mode on the rail: Canvas, or a plugin view container. */
export type ShellMode =
  | { kind: "canvas"; id: typeof CANVAS_MODE_ID; order?: undefined }
  | { kind: "plugin"; id: string; order?: number; container: ViewContainerEntry }

const CANVAS_MODE: ShellMode = { kind: "canvas", id: CANVAS_MODE_ID }

export interface ShellNav {
  pathname: string
  /** Destination awaiting a route commit, including a cold dev compilation. */
  pendingRoute: string | null
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
  /**
   * Plugin view containers that want a rail entry and pass their `when`, in
   * their declared `order` (`PluginViewContainerDef.order`), before the user's
   * own arrangement — `modes` is what the rail renders.
   */
  railContainers: ViewContainerEntry[]
  /**
   * Canvas and `railContainers` resolved against `SidebarLayout.modes`:
   * `visible` is what the rail and the hosted rows draw, in order; `hidden`
   * is what the customizer offers to bring back; `order` is both.
   */
  modes: ResolvedOrderedCatalog<ShellMode>
  layout: UseSidebarLayout
  switchToDm: () => void
  switchToCanvas: () => void
  switchToTeam: (teamId: string) => void
  switchToViewContainer: (containerId: string) => void
  goToFeature: (route: string) => void
}

/**
 * The workspace modes — Canvas plus every plugin view container that wants a
 * rail entry and passes its `when` — resolved against the stored mode layout.
 * `useShellNav` renders from it; the customizer (`sidebar-customizer.tsx`)
 * edits it, and must list exactly the modes the rail could show.
 */
export function useShellModes(
  storedModes: SidebarModesLayout | undefined
): Pick<ShellNav, "railContainers" | "modes"> {
  // Plugin-contributed view containers (B1). Re-render on registry mutation
  // and on context-key changes (the `when` filter reads the context store).
  const viewContainers = useSyncExternalStore(
    subscribeViewContainers,
    getViewContainerSnapshot,
    getViewContainerSnapshot
  )
  const contextRevision = useSyncExternalStore(subscribeContextKeys, getContextKeyRevision, () => 0)
  return useMemo(() => {
    const pluginModes = defaultModeOrder(
      viewContainers
        .filter((c) => c.def.location !== "panel" && evaluateContextWhen(c.def.when))
        .map((container): ShellMode => ({
          kind: "plugin",
          id: container.fullId,
          order: container.def.order,
          container,
        }))
    )
    return {
      railContainers: pluginModes.flatMap((mode) =>
        mode.kind === "plugin" ? [mode.container] : []
      ),
      // The declared order is only the default; a stored `modes.order` wins.
      modes: resolveSidebarModes<ShellMode>([CANVAS_MODE, ...pluginModes], storedModes),
    }
    // `contextRevision` is the dependency the `when` filter reads through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewContainers, contextRevision, storedModes])
}

export function useShellNav(): ShellNav {
  const router = useRouter()
  const pathname = usePathname() ?? "/"
  const [isPending, startTransition] = useTransition()
  const [requestedRoute, setRequestedRoute] = useState<string | null>(null)
  const selected = useUIStore((s) => s.selectedGuild)
  const setSelected = useUIStore((s) => s.setSelectedGuild)
  const layout = useSidebarLayout()
  const { railContainers, modes } = useShellModes(layout.modes)

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

  const navigate = useCallback(
    (route: string) => {
      setRequestedRoute(route)
      startTransition(() => router.push(route))
    },
    [router]
  )

  const goHome = useCallback(() => {
    if (!onHomeRoute) navigate("/")
  }, [onHomeRoute, navigate])

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
      navigate(route)
    },
    [navigate]
  )

  return {
    pathname,
    pendingRoute: isPending ? requestedRoute : null,
    onHomeRoute,
    selected,
    isDmActive,
    isCanvasActive,
    isTeamActive,
    isViewContainerActive,
    isFeatureActive,
    overflowActive,
    railContainers,
    modes,
    layout,
    switchToDm,
    switchToCanvas,
    switchToTeam,
    switchToViewContainer,
    goToFeature,
  }
}
