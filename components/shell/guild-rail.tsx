"use client"

import { WebGlobalStatusRail } from "@/components/shell/web-status"
import { useCallback, useMemo, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Kbd } from "@/components/ui/kbd"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { CountPill } from "@/components/shared/count-pill"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { avatarColor } from "@/lib/ui/avatar"
import { loggers } from "@cognia/logging"
import { useOrderedTeams } from "@/hooks/shell/use-ordered-teams"
import { useEdgePanelTransition } from "@/hooks/shell/use-edge-panel-transition"
import { useReportShellColumn } from "@/hooks/shell/use-report-shell-column"
import { useTeamMute, useVisibleGuildUnread } from "@/hooks/shell/use-team-mute"
import {
  useAppShortcutLabels,
  type AppShortcutLabel,
} from "@/hooks/shortcuts/use-app-shortcut-label"
import { navBadgeCount } from "@/lib/shell/nav-badges"
import type { Team } from "@cognia/agent-config-types"
import {
  BellOffIcon,
  EllipsisIcon,
  MessagesSquareIcon,
  PanelLeftOpenIcon,
  PanelRightOpenIcon,
  PencilRulerIcon,
  PlusIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useUIStore } from "@/stores/ui"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { ResolvedRailIcon } from "@/components/shell/plugin-view-container-panel"
import { useRouter } from "next/navigation"
import { useShellNavModel } from "./use-shell-nav"
import { MoreMenuContent } from "./more-menu"
import { NavItemContextMenu } from "./nav-item-menu"
import { NavSortableItem, NavSortableList } from "./nav-sortable"
import { OverlaySideContext, overlaySideFor, useOverlaySide } from "./rail-overlay-side"
import { ShellLayoutDialog } from "./shell-layout-dialog"
import { GuildScopeMenuItems } from "./sidebar-guild-sections"
import { SidebarRovingGroup, SidebarRowsScope, useSidebarRowRoving } from "./sidebar-row-roving"
import { useShellNavShortcuts } from "./use-shell-nav-shortcuts"
import { startGuildConversation } from "@/lib/shell/start-guild-conversation"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { GUILD_RAIL_WIDTH_PX, type SidebarSide } from "@/types/shell/sidebar"

const log = loggers.ui

/**
 * Rail geometry: 36px targets under the panel radius, every glyph at 18px,
 * hairline dividers cut to nub-length, and the active item carrying both the
 * traveling tint and a detached bar on the window edge — so the selection
 * reads at a glance instead of relying on a faint fill alone.
 */
const RAIL_BUTTON_CLASS = "size-9 rounded-panel transition-colors hover:bg-foreground/[0.05]"
const RAIL_BUTTON_IDLE_CLASS = "text-muted-foreground hover:text-foreground"
const RAIL_ICON_CLASS = "size-[18px]"
const RAIL_SELECTION_TINT_CLASS = "absolute inset-0 rounded-panel bg-foreground/[0.07]"
const RAIL_EDGE_BAR_CLASS = "h-5 w-[3px] rounded-pill bg-primary"
/** From the button's own edge back to the column's window edge. */
const RAIL_EDGE_BAR_OFFSET_PX = 10

/**
 * The edge bar detaches from the button and sits on the column's window edge
 * — the opposite side from where overlays open.
 */
function railEdgeStyle(overlaySide: "left" | "right") {
  return overlaySide === "right"
    ? { left: -RAIL_EDGE_BAR_OFFSET_PX }
    : { right: -RAIL_EDGE_BAR_OFFSET_PX }
}

interface Props {
  onCreateTeam: () => void
  onOpenSettings: () => void
  /**
   * Where the rail is mounted.
   *
   * - `"rail"` (default) — the desktop shell's fixed left column. It collapses
   *   below `md` because `DesktopAppShell` keys its mobile bail-out on the
   *   Capacitor *runtime*, not the viewport, so a narrow desktop window would
   *   otherwise keep a 56px rail it has no room for.
   * - `"sheet"` — inside the mobile nav Sheet, which supplies its own width
   *   constraint. The breakpoint gate must NOT apply here: a phone viewport is
   *   always below `md`, so `hidden md:flex` collapsed the whole rail to
   *   nothing — the workspace switcher, DM/Canvas, every pinned destination,
   *   "More", the team list and Settings were all mounted and invisible.
   */
  variant?: "rail" | "sheet"
  /**
   * Collapse the rail to zero width instead of unmounting it.
   *
   * The shell used to render `null` for both of the reasons this column goes
   * away — the View menu's toggle, and the expanded sidebar taking over the
   * navigation — which dropped 56px out of the window in a single frame. The
   * second case is the worse of the two: it fires *with* the sidebar's own
   * width animation, so a smooth 260px collapse ended on an instant 56px jolt
   * in the opposite direction. Collapsing on the shared edge-panel clock puts
   * both columns on one gesture.
   *
   * Only meaningful for `variant="rail"`; inside the mobile Sheet the rail is
   * the drawer's leading column and is never collapsed.
   */
  collapsed?: boolean
}

/**
 * The 56px-wide navigation rail. Discord-style top-level navigation extended
 * with route-aware feature buttons.
 *
 * It is also the *collapsed* form of the workspace sidebar: while the
 * conversation rail is expanded on `/` it hosts these same destinations as
 * labelled rows (`sidebar-nav-section.tsx`) and the shell hides this column
 * (`sidebarHostsNav`); collapse the sidebar, or leave `/`, and the icon
 * column is back. Both render from `useShellNavModel` — labels, counts,
 * chords, every reorder / hide / pin handler — and share each item's
 * right-click menu (`nav-item-menu.tsx`), so they cannot drift.
 *
 *   ┌── Workspace switcher ──┐
 *   ├─ DM · Canvas · plugins ┤ ← chat guilds; Canvas + plugin modes are
 *   │                        │   user-ordered / hideable (`SidebarLayout.modes`)
 *   ├──── Pinned features ───┤ ← user-customizable; router.push to routes
 *   ├──── ⋯ More ───────────┤ ← overflow popover (non-pinned items + Customize)
 *   ├──── Teams (dynamic) ───┤ ← chat guilds (per-team conversation list)
 *   └────── Settings ────────┘
 *
 * Which items are pinned vs. in "More" (vs. hidden) is user customization
 * persisted on `settings.sidebarLayout` and resolved via `useSidebarLayout`.
 * Active state is computed from `usePathname()` for feature buttons and from
 * `selectedGuild` for chat buttons (when on `/`). Every ordered block —
 * modes, pins, teams — can be dragged in place or moved from its item's
 * context menu.
 *
 * It is a `<nav>` landmark with one tab stop: arrow keys / Home / End move
 * between its buttons (`sidebar-row-roving.tsx`, the same roving the expanded
 * sidebar's rows use) — the workspace switcher, the web shell's status
 * segments and plugin contributions included — and each block is a labelled
 * `role="group"`.
 *
 * Which edge it occupies is `settings.sidebarSide`. Everything that opens
 * sideways — tooltips, the "More" popover, the workspace switcher — has to
 * open *inward*, so the side is provided through `OverlaySideContext` rather
 * than hard-coded.
 */
export function GuildRail({
  onCreateTeam,
  onOpenSettings,
  variant = "rail",
  collapsed = false,
}: Props) {
  const t = useTranslations("desktop.guildRail")
  const listT = useTranslations("desktop.channelList")
  const commonT = useTranslations("common")
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed)
  const setSidebarCollapsed = useUIStore((state) => state.setSidebarCollapsed)
  // Same order the expanded sidebar's accordion shows — the rail is that
  // sidebar folded up, so a team dragged there is in the same slot here.
  const { teams, teamIds, reorderTeams, moveTeam } = useOrderedTeams()
  const {
    pathname,
    pendingRoute,
    selected,
    isDmActive,
    isTeamActive,
    isFeatureActive,
    overflowActive,
    modes,
    layout: { resolved, side },
    switchToDm,
    switchToTeam,
    goToFeature,
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
    reorderPinnedIds,
    modeMenu,
    pinnedMenu,
    moreOpen,
    setMoreOpen,
    customizeOpen,
    setCustomizeOpen,
    openOverflowItem,
    openCustomize,
    pinItem,
    hideItem,
  } = useShellNavModel()
  // An icon column has no room for the conversation rows, so each guild button
  // carries the count its section holds — the same aggregate the expanded
  // sidebar's closed rows show (`hooks/shell/use-guild-unread.ts`), minus the
  // teams the user muted.
  const unread = useVisibleGuildUnread()
  const { isMuted } = useTeamMute()
  const router = useRouter()
  /** "3 unread" — folded into each guild button's accessible name. */
  const unreadLabel = (count: number) => t("unreadCount", { count })
  /** "3 waiting" — the same for a feature's badge. */
  const badgeLabel = (count: number) => t("badgeCount", { count })
  // The rail is mounted on every route, where no chat workspace exists to
  // hand it creation handlers — so its menus go through the shared starter,
  // which selects the guild, creates the session and brings the user home.
  const startConversation = (teamId: string | null) => {
    if (teamId) {
      void startGuildConversation({
        teamId,
        teamTitle: listT("newConversation"),
        navigate: router.push,
        pathname,
      })
      return
    }
    void startGuildConversation({ teamId: null, navigate: router.push, pathname })
  }
  // The title bar sizes its start / end outlets from the rail's rendered
  // width — measured, not assumed, so a hidden rail (below `md`, or while the
  // sidebar hosts the navigation) counts as 0 without a second flag.
  const navRef = useRef<HTMLElement | null>(null)
  // Never collapse the Sheet's copy — there it is the drawer's leading column.
  const railCollapsed = variant === "rail" && collapsed
  const animatingCollapse = useEdgePanelTransition(railCollapsed, { element: navRef })
  // Reports the rail's *rendered* width — and where it is headed while it
  // animates — so the title bar's outlets track the collapse instead of
  // jumping when it finishes. That is why the width animates on the `<nav>`
  // itself rather than on a wrapper: a clipping wrapper would leave this
  // measuring a full-width rail nobody can see.
  // See `stores/ui/shell-columns-store.ts`.
  useReportShellColumn(
    "rail",
    navRef,
    animatingCollapse ? (railCollapsed ? 0 : GUILD_RAIL_WIDTH_PX) : null
  )

  // Inside the mobile nav Sheet the rail is not on a window edge at all — it is
  // the drawer's leading column with the channel list to its right, so overlays
  // must open rightward regardless of the desktop preference.
  const effectiveSide: SidebarSide = variant === "sheet" ? "left" : side
  /** Where tooltips and the "More" popover open: inward, away from the edge. */
  const overlaySide = overlaySideFor(effectiveSide)

  const handleCreateTeam = () => {
    log.info("guild create team click")
    onCreateTeam()
  }
  const handleOpenSettings = useCallback(() => {
    log.info("guild open settings")
    onOpenSettings()
  }, [onOpenSettings])

  // ⌥1…⌥9 and the web shell's ⌘, — bound here because this column is
  // mounted for the whole desktop session (collapsed, never unmounted).
  useShellNavShortcuts({
    enabled: variant === "rail",
    pinned: resolved.pinned,
    goToFeature,
    openSettings: handleOpenSettings,
  })

  const teamLabelById = useCallback(
    (id: string) => teams?.find((team) => team.id === id)?.name ?? id,
    [teams]
  )

  return (
    <OverlaySideContext.Provider value={overlaySide}>
      <nav
        ref={navRef}
        // Tint, no border — on the left. Shell chrome (this rail, the title bar,
        // the status bar) separates from content by its `bg-muted/40` tone alone;
        // stacking a border on top of a tone difference draws the seam twice.
        //
        // On the right the tone alone is not enough. The rail then abuts
        // `ContextWorkbench`, which declares the *same* `data-bg-target="sidebar"`
        // wallpaper scope (`context-workbench.tsx`) — with a background image on,
        // `background-applier.tsx` paints both from one scope and the seam
        // disappears entirely. The border is what keeps a 56px navigation rail
        // and a 48px activity rail from reading as one 104px column.
        className={cn(
          "h-full shrink-0 flex-col bg-muted/40",
          // The fixed-width inner column below is what the rail actually draws;
          // this box only owns the space it takes. Anchor that column to the
          // *inboard* edge so collapsing slides it off toward its own window
          // edge rather than eating it from the inside.
          effectiveSide === "right" ? "items-start" : "items-end",
          effectiveSide === "right" && !railCollapsed && "border-l",
          variant === "sheet" ? "flex" : "hidden md:flex",
          // Clipped while it is shut or moving; left open at rest so a button's
          // focus ring and its inward tooltip are not shaved off.
          (railCollapsed || animatingCollapse) && "overflow-hidden",
          animatingCollapse && `transition-[width] ${SHELL_DOCK_TIMING_CLASS}`
        )}
        style={variant === "rail" ? { width: railCollapsed ? 0 : GUILD_RAIL_WIDTH_PX } : undefined}
        aria-label={t("navigation")}
        data-testid="guild-rail"
        data-variant={variant}
        data-side={effectiveSide}
        data-collapsed={railCollapsed || undefined}
        data-bg-target="sidebar"
        aria-hidden={railCollapsed || undefined}
        inert={railCollapsed || undefined}
      >
        {pendingRoute ? (
          <span role="status" className="sr-only">
            {commonT("loading")}
          </span>
        ) : null}
        {/* Fixed-width column: keeps the icons from being squeezed toward each
            other as the aside's width animates — they are clipped, not
            crushed. Mirrors the conversation sidebar's inner layer. It is also
            the roving-focus scope: one tab stop for every rail button. */}
        <SidebarRowsScope className="flex min-h-0 w-14 flex-1 flex-col items-center py-2.5">
          <ScrollArea className="w-full flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden">
            <div className="flex flex-col items-center gap-1.5 px-2">
              {/* Controls the rail hosts but does not render join its arrow-key
                  order through a roving group; see `SidebarRovingGroup`. */}
              <SidebarRovingGroup groupKey="rail-plugins-top" className="contents">
                <PluginExtensionSlot
                  point="sidebar.left.top"
                  className="flex flex-col items-center gap-2 empty:hidden"
                />
              </SidebarRovingGroup>
              <WorkspaceSwitcher className="size-9 rounded-panel bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.09]" />
              <Separator className="my-1.5 w-4" />
              <div
                role="group"
                aria-label={t("workspacesGroup")}
                className="flex flex-col items-center gap-1.5"
              >
                <GuildContextMenu
                  target={{ kind: "dm" }}
                  unread={unread.dm}
                  onNewConversation={startConversation}
                >
                  <RailButton
                    active={isDmActive}
                    pending={pendingRoute === "/" && selected.kind === "dm"}
                    ariaLabel={t("directMessages")}
                    tooltip={t("directMessages")}
                    onClick={switchToDm}
                    badge={unread.dm}
                    badgeLabel={unreadLabel}
                    testId="guild-dm"
                  >
                    <MessagesSquareIcon className={RAIL_ICON_CLASS} />
                  </RailButton>
                </GuildContextMenu>

                <NavSortableList
                  ids={visibleModeIds}
                  onReorder={reorderVisibleModes}
                  labelOf={modeLabelById}
                >
                  {modes.visible.map((mode, index) => {
                    const testId =
                      mode.kind === "canvas" ? "guild-canvas" : `guild-view-container-${mode.id}`
                    const label = modeLabel(mode)
                    return (
                      <NavSortableItem key={mode.id} id={mode.id}>
                        {(drag) => (
                          <NavItemContextMenu
                            drag={drag}
                            menuTestId={`${testId}-menu`}
                            {...modeMenu(mode, index)}
                          >
                            <RailButton
                              active={isModeActive(mode)}
                              pending={isModePending(mode)}
                              ariaLabel={label}
                              tooltip={label}
                              onClick={() => selectMode(mode)}
                              testId={testId}
                            >
                              {mode.kind === "canvas" ? (
                                <PencilRulerIcon className={RAIL_ICON_CLASS} />
                              ) : (
                                <ResolvedRailIcon
                                  name={mode.container.def.icon}
                                  className={RAIL_ICON_CLASS}
                                />
                              )}
                            </RailButton>
                          </NavItemContextMenu>
                        )}
                      </NavSortableItem>
                    )
                  })}
                </NavSortableList>
              </div>

              <Separator className="my-1.5 w-4" />

              <div
                role="group"
                aria-label={t("featuresGroup")}
                className="flex flex-col items-center gap-1.5"
              >
                <NavSortableList
                  ids={pinnedIds}
                  onReorder={reorderPinnedIds}
                  labelOf={pinnedLabelById}
                >
                  {resolved.pinned.map((item, index) => {
                    const label = pinnedLabel(item)
                    return (
                      <NavSortableItem key={item.id} id={item.id}>
                        {(drag) => (
                          <NavItemContextMenu
                            drag={drag}
                            menuTestId={`guild-feature-menu-${item.id}`}
                            {...pinnedMenu(item, index)}
                          >
                            <RailButton
                              active={isFeatureActive(item.route)}
                              pending={pendingRoute === item.route}
                              ariaLabel={label}
                              tooltip={label}
                              onClick={() => goToFeature(item.route)}
                              badge={navBadgeCount(badges, item.id)}
                              badgeLabel={badgeLabel}
                              shortcut={pinnedShortcuts[index]}
                              testId={`guild-feature-${item.id}`}
                            >
                              <item.Icon className={RAIL_ICON_CLASS} />
                            </RailButton>
                          </NavItemContextMenu>
                        )}
                      </NavSortableItem>
                    )
                  })}
                </NavSortableList>

                {resolved.overflow.length > 0 && (
                  <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                    <PopoverTrigger asChild>
                      <RailMoreButton
                        active={overflowActive}
                        pending={overflowPending}
                        label={
                          overflowBadge > 0
                            ? `${t("more")}, ${badgeLabel(overflowBadge)}`
                            : t("more")
                        }
                        hasBadge={overflowBadge > 0}
                      />
                    </PopoverTrigger>
                    <PopoverContent
                      side={overlaySide}
                      align="start"
                      className="w-62 p-0"
                      onOpenAutoFocus={(e) => e.preventDefault()}
                    >
                      <MoreMenuContent
                        items={resolved.overflow}
                        isActive={isFeatureActive}
                        badges={badges}
                        onOpen={openOverflowItem}
                        onPin={pinItem}
                        onHide={hideItem}
                        onCustomize={openCustomize}
                        testIdPrefix="guild-more"
                      />
                    </PopoverContent>
                  </Popover>
                )}
              </div>

              <Separator className="my-1.5 w-4" />

              <div
                role="group"
                aria-label={t("teamsGroup")}
                className="flex flex-col items-center gap-1.5"
              >
                <NavSortableList ids={teamIds} onReorder={reorderTeams} labelOf={teamLabelById}>
                  <ul className="flex flex-col items-center gap-1.5">
                    {(teams ?? []).map((team, index) => (
                      <NavSortableItem key={team.id} id={team.id}>
                        {(drag) => (
                          <li
                            ref={drag.setNodeRef}
                            style={drag.style}
                            className={cn(drag.dragging && "z-10 opacity-50")}
                          >
                            <GuildContextMenu
                              target={{ kind: "team", teamId: team.id }}
                              unread={unread.teams.get(team.id) ?? 0}
                              onNewConversation={startConversation}
                              onMoveTeam={moveTeam}
                              teamPosition={{ index, count: teamIds.length }}
                              handleProps={drag.handleProps}
                            >
                              <TeamButton
                                team={team}
                                active={isTeamActive(team.id)}
                                pending={
                                  pendingRoute === "/" &&
                                  selected.kind === "team" &&
                                  selected.teamId === team.id
                                }
                                onSelect={() => switchToTeam(team.id)}
                                unread={unread.teams.get(team.id) ?? 0}
                                unreadLabel={unreadLabel}
                                muted={isMuted(team.id)}
                                mutedLabel={t("teamMuted", { name: team.name })}
                              />
                            </GuildContextMenu>
                          </li>
                        )}
                      </NavSortableItem>
                    ))}
                  </ul>
                </NavSortableList>
                <RailButton
                  ariaLabel={t("createTeam")}
                  tooltip={t("createTeam")}
                  onClick={handleCreateTeam}
                  testId="guild-create-team"
                >
                  <PlusIcon className={RAIL_ICON_CLASS} />
                </RailButton>
              </div>
            </div>
          </ScrollArea>

          <Separator className="my-2 w-4" />

          <SidebarRovingGroup groupKey="rail-status" className="contents">
            <WebGlobalStatusRail collapsed={collapsed} />
          </SidebarRovingGroup>

          {/* The Settings gear also carries "Customize navigation": it is the
              one control on the rail that can never be hidden, so the way back
              to a navigation the user emptied is always one right-click away. */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div>
                <RailButton
                  active={pathname === "/settings" || pathname.startsWith("/settings/")}
                  ariaLabel={t("openSettings")}
                  tooltip={t("settings")}
                  onClick={handleOpenSettings}
                  testId="guild-open-settings"
                  shortcutId="shell.settings.open"
                >
                  <SettingsIcon className={RAIL_ICON_CLASS} />
                </RailButton>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent data-testid="guild-settings-menu">
              <ContextMenuItem
                onSelect={() => setCustomizeOpen(true)}
                data-testid="guild-settings-menu-customize"
              >
                <SlidersHorizontalIcon className="size-4" />
                {t("customize.title")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          {variant === "rail" &&
          pathname === "/" &&
          selected.kind !== "canvas" &&
          sidebarCollapsed ? (
            <RailButton
              ariaLabel={listT("expandSidebar")}
              tooltip={listT("expandSidebar")}
              ariaControls="conversation-sidebar"
              ariaExpanded={false}
              onClick={() => setSidebarCollapsed(false)}
              testId="guild-expand-sidebar"
              shortcutId="shell.sidebar.toggle"
              className="mt-1.5"
            >
              {side === "right" ? (
                <PanelRightOpenIcon className={RAIL_ICON_CLASS} aria-hidden />
              ) : (
                <PanelLeftOpenIcon className={RAIL_ICON_CLASS} aria-hidden />
              )}
            </RailButton>
          ) : null}

          <SidebarRovingGroup groupKey="rail-plugins-bottom" className="contents">
            <PluginExtensionSlot
              point="sidebar.left.bottom"
              className="mt-2 flex flex-col items-center gap-2 empty:hidden"
            />
          </SidebarRovingGroup>
        </SidebarRowsScope>

        <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="sidebar" />
      </nav>
    </OverlaySideContext.Provider>
  )
}

/**
 * The rail's "⋯ More" trigger. Its own component so it can join the roving
 * tab order like every `RailButton`; props and ref come from `PopoverTrigger`.
 */
function RailMoreButton({
  active,
  pending,
  label,
  hasBadge,
  ...triggerProps
}: {
  active: boolean
  pending: boolean
  label: string
  /** Something in the overflow is waiting: a dot, since the count is in the label. */
  hasBadge: boolean
} & React.ComponentPropsWithRef<"button">) {
  const overlaySide = useOverlaySide()
  const roving = useSidebarRowRoving("guild-more", active)
  return (
    <Button
      variant="ghost"
      size="icon"
      {...triggerProps}
      {...roving.rowProps}
      tabIndex={roving.tabIndex}
      onKeyDown={(event) => {
        triggerProps.onKeyDown?.(event)
        if (!event.defaultPrevented) roving.onKeyDown?.(event)
      }}
      onFocus={(event) => {
        triggerProps.onFocus?.(event)
        roving.onFocus?.()
      }}
      aria-label={label}
      aria-busy={pending}
      data-testid="guild-more"
      className={cn(
        "relative",
        RAIL_BUTTON_CLASS,
        active ? "text-foreground" : RAIL_BUTTON_IDLE_CLASS
      )}
    >
      {/* Same group as the rail buttons — "More" standing in for an active
          overflow route is just another selection. */}
      <MotionSelectionIndicator
        groupId="guild-rail-selection"
        active={active}
        className={RAIL_SELECTION_TINT_CLASS}
      />
      {active ? (
        <span
          aria-hidden
          className={cn("absolute top-1/2 -translate-y-1/2", RAIL_EDGE_BAR_CLASS)}
          style={railEdgeStyle(overlaySide)}
        />
      ) : null}
      {pending ? (
        <Spinner className="relative size-[18px]" />
      ) : (
        <EllipsisIcon className="relative size-[18px]" />
      )}
      {hasBadge ? (
        <span
          aria-hidden
          data-testid="guild-more-badge"
          className="absolute top-1 right-1 size-2 rounded-full bg-primary"
        />
      ) : null}
    </Button>
  )
}

interface RailButtonProps {
  active?: boolean
  pending?: boolean
  ariaLabel: string
  ariaControls?: string
  ariaExpanded?: boolean
  tooltip: string
  onClick: () => void
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  /** Also the button's key in the rail's roving focus order. */
  testId: string
  /**
   * What is waiting behind this button — unread conversations for a guild,
   * the feature's count for a pin. Drawn as a corner badge, and folded into
   * the accessible name: a screen reader gets "Alpha, 3 unread", not a
   * decorative pill it cannot see.
   */
  badge?: number
  badgeLabel?: (count: number) => string
  /** A muted team: a quiet glyph instead of a badge, with its own name. */
  muted?: boolean
  /** Keyboard shortcut to print in the tooltip and announce. */
  shortcut?: AppShortcutLabel
  /** Or: an `app` shortcut id whose live chord is printed (see `RailShortcutButton`). */
  shortcutId?: string
}

function RailButton(props: RailButtonProps) {
  if (props.shortcutId) return <RailShortcutButton {...props} shortcutId={props.shortcutId} />
  return <RailButtonBase {...props} />
}

/** A `RailButton` that reads its chord from the keybinding store. */
function RailShortcutButton(props: RailButtonProps & { shortcutId: string }) {
  const [shortcut] = useAppShortcutLabels(useMemo(() => [props.shortcutId], [props.shortcutId]))
  return <RailButtonBase {...props} shortcut={shortcut} />
}

function RailButtonBase({
  active = false,
  pending = false,
  ariaLabel,
  ariaControls,
  ariaExpanded,
  tooltip,
  onClick,
  children,
  className,
  style,
  testId,
  badge = 0,
  badgeLabel,
  muted = false,
  shortcut,
}: RailButtonProps) {
  const overlaySide = useOverlaySide()
  // One tab stop for the whole rail; the active destination holds it so
  // tabbing in lands where the user already is.
  const roving = useSidebarRowRoving(testId, active)
  const showBadge = badge > 0 && !muted
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          {...roving.rowProps}
          tabIndex={roving.tabIndex}
          onKeyDown={roving.onKeyDown}
          onFocus={roving.onFocus}
          aria-label={showBadge && badgeLabel ? `${ariaLabel}, ${badgeLabel(badge)}` : ariaLabel}
          aria-controls={ariaControls}
          aria-expanded={ariaExpanded}
          aria-current={active ? "page" : undefined}
          aria-busy={pending}
          aria-keyshortcuts={shortcut?.aria}
          onClick={onClick}
          style={style}
          data-testid={testId}
          className={cn(
            "relative",
            RAIL_BUTTON_CLASS,
            active ? "text-foreground" : RAIL_BUTTON_IDLE_CLASS,
            className
          )}
        >
          {/* One group for the whole rail: at most one button is ever active
              (a guild only counts on `/`, a feature only off it), so the tint
              can travel the full column instead of blinking between sections. */}
          <MotionSelectionIndicator
            groupId="guild-rail-selection"
            active={active}
            className={RAIL_SELECTION_TINT_CLASS}
          />
          {active ? (
            <span
              aria-hidden
              className={cn("absolute top-1/2 -translate-y-1/2", RAIL_EDGE_BAR_CLASS)}
              style={railEdgeStyle(overlaySide)}
            />
          ) : null}
          <span className="relative flex items-center justify-center">
            {pending ? <Spinner className={RAIL_ICON_CLASS} /> : children}
          </span>
          {showBadge ? (
            // Corner pill, outside the icon's optical square so it never sits
            // over the avatar's initial. `aria-hidden`: the count is already
            // in the button's accessible name above.
            <CountPill count={badge} placement="corner" decorative testId={`${testId}-unread`} />
          ) : null}
          {muted ? (
            <span
              aria-hidden
              data-testid={`${testId}-muted`}
              className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-muted text-muted-foreground"
            >
              <BellOffIcon className="size-2.5" />
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={overlaySide}>
        {tooltip}
        {shortcut?.label ? (
          <Kbd aria-hidden className="ml-2 text-[10px]">
            {shortcut.label}
          </Kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}

function TeamButton({
  team,
  active,
  pending,
  onSelect,
  unread = 0,
  unreadLabel,
  muted,
  mutedLabel,
}: {
  team: Team
  active: boolean
  pending?: boolean
  onSelect: () => void
  unread?: number
  unreadLabel?: (count: number) => string
  muted: boolean
  /** "Alpha (muted)" — the name the button carries while muted. */
  mutedLabel: string
}) {
  return (
    <RailButton
      active={active}
      pending={pending}
      ariaLabel={muted ? mutedLabel : team.name}
      tooltip={muted ? mutedLabel : team.name}
      onClick={onSelect}
      badge={unread}
      badgeLabel={unreadLabel}
      muted={muted}
      testId={`guild-team-${team.id}`}
      className="text-base"
      style={active ? { boxShadow: `inset 0 0 0 2px ${avatarColor(team)}` } : undefined}
    >
      <AvatarBadge subject={team} size={28} textClassName="text-sm" />
    </RailButton>
  )
}

/**
 * Right-click menu for a guild button — the icon column's equivalent of the
 * expanded sidebar's guild-row menu. The items are that menu's own
 * (`GuildScopeMenuItems`), so "new conversation", "mark all read", "mute",
 * "move up / down", "edit team" and "manage teams" are one implementation in
 * either state of the sidebar.
 *
 * Wrapped in a `div` so the trigger has one ref-forwarding child around the
 * tooltip-wrapped button, the same shape `NavRailButton` uses. For a team the
 * same `div` carries the drag listeners (`handleProps`).
 */
function GuildContextMenu({
  target,
  unread,
  onNewConversation,
  onMoveTeam,
  teamPosition,
  handleProps,
  children,
}: {
  target: { kind: "dm" } | { kind: "team"; teamId: string }
  unread: number
  onNewConversation: (teamId: string | null) => void
  onMoveTeam?: (teamId: string, delta: number) => void
  teamPosition?: { index: number; count: number }
  handleProps?: Record<string, unknown>
  children: React.ReactNode
}) {
  const teamId = target.kind === "team" ? target.teamId : null
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div {...handleProps}>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid={`guild-menu-${teamId ?? "dm"}`}>
        <GuildScopeMenuItems
          teamId={teamId}
          unreadCount={unread}
          onNewConversation={onNewConversation}
          onMoveTeam={onMoveTeam}
          teamPosition={teamPosition}
          testIdPrefix="guild-menu"
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}
