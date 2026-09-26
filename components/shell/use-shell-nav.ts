"use client"

/**
 * The shell's top-level navigation model — one hook behind two renderings.
 *
 * Two layers: `useShellNav` is the routing model (what is active, where a
 * click goes), and `useShellNavModel` adds everything a *rendering* of it
 * needs on top — labels, live counts, ⌥N chords, the reorder / hide / pin
 * handlers each item's context menu offers, and the "More" / customizer
 * open state. `GuildRail` and `SidebarNavSection` both render from
 * `useShellNavModel`, so neither re-derives any of it.
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
import { useTranslations } from "next-intl"
import { loggers } from "@cognia/logging"
import { useUIStore } from "@/stores/ui"
import { useNavBadges } from "@/hooks/shell/use-nav-badges"
import {
  usePinnedNavShortcutLabels,
  type AppShortcutLabel,
} from "@/hooks/shortcuts/use-app-shortcut-label"
import { sumNavBadges, type NavBadgeCounts } from "@/lib/shell/nav-badges"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
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
import {
  defaultModeOrder,
  mergeVisibleModeOrder,
  moveVisibleMode,
  resolveSidebarModes,
  type SidebarCatalogItem,
} from "@/lib/shell/sidebar-nav"
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

/**
 * A workspace mode's display name: Canvas from the rail's own strings, a
 * plugin view container from its plugin's locale (falling back to the
 * container's declared title). The rail, the hosted rows and the customizer
 * all name a mode this one way.
 */
export function useShellModeLabel(): (mode: ShellMode) => string {
  const t = useTranslations("desktop.guildRail")
  const pluginT = useTranslations()
  return useCallback(
    (mode: ShellMode) =>
      mode.kind === "canvas"
        ? t("canvas")
        : resolvePluginLabel(
            pluginT as never,
            mode.container.pluginId,
            mode.container.def.titleKey,
            mode.container.def.title
          ),
    [t, pluginT]
  )
}

export interface ShellModeOrdering {
  /** Persist a drag of the *visible* modes. */
  reorderVisibleModes: (visibleOrder: string[]) => void
  /** Move one visible mode by `delta` (`-1` up, `1` down); a no-op at the ends. */
  moveMode: (id: string, delta: number) => void
}

/**
 * Reordering the workspace modes. Both writes carry the whole stored order,
 * hidden modes included, so a hidden mode keeps its slot instead of being
 * pushed to the end when it comes back.
 */
export function useShellModeOrdering(
  modes: ResolvedOrderedCatalog<ShellMode>,
  reorderModes: (ids: string[]) => Promise<void>
): ShellModeOrdering {
  const orderIds = useMemo(() => modes.order.map((mode) => mode.id), [modes.order])
  const hiddenIds = useMemo(() => new Set(modes.hidden.map((mode) => mode.id)), [modes.hidden])
  const reorderVisibleModes = useCallback(
    (visibleOrder: string[]) =>
      void reorderModes(mergeVisibleModeOrder(orderIds, hiddenIds, visibleOrder)),
    [orderIds, hiddenIds, reorderModes]
  )
  const moveMode = useCallback(
    (id: string, delta: number) => {
      const next = moveVisibleMode(orderIds, hiddenIds, id, delta)
      if (next) void reorderModes(next)
    },
    [orderIds, hiddenIds, reorderModes]
  )
  return { reorderVisibleModes, moveMode }
}

/**
 * What one nav item's right-click menu offers (`nav-item-menu.tsx`), already
 * bound to that item. `onMoveToMore` is only present for a pinned feature —
 * a workspace mode has no "More" to fall back to.
 */
export interface ShellNavItemMenu {
  canMoveUp: boolean
  canMoveDown: boolean
  /** `-1` up, `1` down. */
  onMove: (delta: number) => void
  onMoveToMore?: () => void
  onHide: () => void
  onCustomize: () => void
}

export interface ShellNavModel extends ShellNav, ShellModeOrdering {
  /** Live counts by catalog id (`lib/shell/nav-badges.ts`). */
  badges: NavBadgeCounts
  /** Everything waiting behind "More", summed. */
  overflowBadge: number
  /** A route folded into "More" is loading. */
  overflowPending: boolean
  /** ⌥1…⌥9 by pinned slot; entries past the ninth are absent. */
  pinnedShortcuts: AppShortcutLabel[]
  modeLabel: (mode: ShellMode) => string
  /** For dnd-kit's announcements, which only know ids. */
  modeLabelById: (id: string) => string
  pinnedLabel: (item: SidebarCatalogItem) => string
  pinnedLabelById: (id: string) => string
  visibleModeIds: string[]
  pinnedIds: string[]
  isModeActive: (mode: ShellMode) => boolean
  /** The mode's switch is waiting on the route home to commit. */
  isModePending: (mode: ShellMode) => boolean
  selectMode: (mode: ShellMode) => void
  reorderPinnedIds: (ids: string[]) => void
  /** The bound context-menu actions for the visible mode at `index`. */
  modeMenu: (mode: ShellMode, index: number) => ShellNavItemMenu
  /** The bound context-menu actions for the pinned feature at `index`. */
  pinnedMenu: (item: SidebarCatalogItem, index: number) => ShellNavItemMenu
  moreOpen: boolean
  setMoreOpen: (open: boolean) => void
  customizeOpen: boolean
  setCustomizeOpen: (open: boolean) => void
  /** Open an overflow entry: close "More", then navigate. */
  openOverflowItem: (route: string) => void
  /** "Customize" from inside "More": close it, then open the customizer. */
  openCustomize: () => void
  /** Pin an overflow entry from "More" without navigating. */
  pinItem: (id: string) => void
  /** Hide a feature everywhere. */
  hideItem: (id: string) => void
}

/**
 * `useShellNav` plus everything a rendering of it needs. Each surface calls
 * it once and owns only its markup; the `moreOpen` / `customizeOpen` state is
 * per surface (each mounts its own popover and dialog), not shared.
 */
export function useShellNavModel(): ShellNavModel {
  const t = useTranslations("desktop.guildRail")
  const nav = useShellNav()
  const {
    pendingRoute,
    selected,
    isCanvasActive,
    isViewContainerActive,
    modes,
    layout: { resolved, pin, unpin, hide, reorderPinned, movePinned, hideMode, reorderModes },
    switchToCanvas,
    switchToViewContainer,
    goToFeature,
  } = nav
  const [moreOpen, setMoreOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const badges = useNavBadges()
  const overflowIds = useMemo(() => resolved.overflow.map((item) => item.id), [resolved.overflow])
  const overflowBadge = sumNavBadges(badges, overflowIds)
  const overflowPending = resolved.overflow.some((item) => item.route === pendingRoute)
  const pinnedShortcuts = usePinnedNavShortcutLabels()

  const modeLabel = useShellModeLabel()
  const { reorderVisibleModes, moveMode } = useShellModeOrdering(modes, reorderModes)
  const visibleModeIds = useMemo(() => modes.visible.map((mode) => mode.id), [modes.visible])
  const modeLabelById = useCallback(
    (id: string) => {
      const mode = modes.visible.find((entry) => entry.id === id)
      return mode ? modeLabel(mode) : id
    },
    [modes.visible, modeLabel]
  )
  const pinnedLabel = useCallback((item: SidebarCatalogItem) => t(item.i18nKey), [t])
  const pinnedIds = useMemo(() => resolved.pinned.map((item) => item.id), [resolved.pinned])
  const pinnedLabelById = useCallback(
    (id: string) => {
      const item = resolved.pinned.find((entry) => entry.id === id)
      return item ? pinnedLabel(item) : id
    },
    [resolved.pinned, pinnedLabel]
  )

  const isModeActive = useCallback(
    (mode: ShellMode) => (mode.kind === "canvas" ? isCanvasActive : isViewContainerActive(mode.id)),
    [isCanvasActive, isViewContainerActive]
  )
  const isModePending = useCallback(
    (mode: ShellMode) =>
      pendingRoute === "/" &&
      (mode.kind === "canvas"
        ? selected.kind === "canvas"
        : selected.kind === "plugin-view" && selected.containerId === mode.id),
    [pendingRoute, selected]
  )
  const selectMode = useCallback(
    (mode: ShellMode) =>
      mode.kind === "canvas" ? switchToCanvas() : switchToViewContainer(mode.id),
    [switchToCanvas, switchToViewContainer]
  )

  const openCustomizer = useCallback(() => setCustomizeOpen(true), [])
  const modeMenu = useCallback(
    (mode: ShellMode, index: number): ShellNavItemMenu => ({
      canMoveUp: index > 0,
      canMoveDown: index < modes.visible.length - 1,
      onMove: (delta) => moveMode(mode.id, delta),
      onHide: () => void hideMode(mode.id),
      onCustomize: openCustomizer,
    }),
    [modes.visible.length, moveMode, hideMode, openCustomizer]
  )
  const pinnedMenu = useCallback(
    (item: SidebarCatalogItem, index: number): ShellNavItemMenu => ({
      canMoveUp: index > 0,
      canMoveDown: index < resolved.pinned.length - 1,
      onMove: (delta) => void movePinned(item.id, delta),
      onMoveToMore: () => void unpin(item.id),
      onHide: () => void hide(item.id),
      onCustomize: openCustomizer,
    }),
    [resolved.pinned.length, movePinned, unpin, hide, openCustomizer]
  )

  const openOverflowItem = useCallback(
    (route: string) => {
      setMoreOpen(false)
      goToFeature(route)
    },
    [goToFeature]
  )
  const openCustomize = useCallback(() => {
    setMoreOpen(false)
    setCustomizeOpen(true)
  }, [])

  return {
    ...nav,
    badges,
    overflowBadge,
    overflowPending,
    pinnedShortcuts,
    modeLabel,
    modeLabelById,
    pinnedLabel,
    pinnedLabelById,
    visibleModeIds,
    pinnedIds,
    isModeActive,
    isModePending,
    selectMode,
    reorderVisibleModes,
    moveMode,
    reorderPinnedIds: (ids) => void reorderPinned(ids),
    modeMenu,
    pinnedMenu,
    moreOpen,
    setMoreOpen,
    customizeOpen,
    setCustomizeOpen,
    openOverflowItem,
    openCustomize,
    pinItem: (id) => void pin(id),
    hideItem: (id) => void hide(id),
  }
}
