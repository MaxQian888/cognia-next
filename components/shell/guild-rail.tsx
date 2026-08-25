"use client"

import { createContext, useContext, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { avatarColor } from "@/lib/ui/avatar"
import { listTeams } from "@/lib/db/teams"
import { loggers } from "@cognia/logging"
import { useClientLiveQuery } from "@/hooks/data"
import { useEdgePanelTransition } from "@/hooks/shell/use-edge-panel-transition"
import { useReportShellColumn } from "@/hooks/shell/use-report-shell-column"
import {
  markGuildRead,
  useGuildUnread,
  type GuildUnreadTarget,
} from "@/hooks/shell/use-guild-unread"
import type { Team } from "@cognia/agent-config-types"
import {
  CheckCheckIcon,
  EllipsisIcon,
  EyeOffIcon,
  MessagesSquareIcon,
  PencilRulerIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { ResolvedRailIcon } from "@/components/shell/plugin-view-container-panel"
import { useRouter } from "next/navigation"
import { useShellNav } from "./use-shell-nav"
import { ShellLayoutDialog } from "./shell-layout-dialog"
import { TEAM_SETTINGS_ROUTE } from "./sidebar-guild-sections"
import { startGuildConversation } from "@/lib/shell/start-guild-conversation"
import { WorkspaceSwitcher } from "./workspace-switcher"
import type { SidebarCatalogItem } from "@/lib/shell/sidebar-nav"
import { GUILD_RAIL_WIDTH_PX, type SidebarSide } from "@/types/shell/sidebar"

const log = loggers.ui

/**
 * Which way this rail's overlays open. A context rather than a prop threaded
 * through `NavRailButton` / `TeamButton` to every `RailButton`: there are seven
 * call sites and a missed one is invisible until the tooltip opens off-screen.
 * Defaults to the left rail's behaviour so a `RailButton` rendered outside a
 * provider (tests, stories) keeps opening rightward.
 */
const OverlaySideContext = createContext<"left" | "right">("right")

interface Props {
  onCreateTeam: () => void
  onOpenSettings: () => void
  /**
   * Where the rail is mounted.
   *
   * - `"rail"` (default) — the desktop shell's fixed left column. It collapses
   *   below `md` because `DesktopAppShell` keys its mobile bail-out on the
   *   Capacitor *runtime*, not the viewport, so a narrow desktop window would
   *   otherwise keep a 64px rail it has no room for.
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
 * column is back. Both read `useShellNav`, so they cannot drift.
 *
 *   ┌───── DM · Canvas ──────┐ ← chat guilds (set selected guild + go to /)
 *   ├──── Pinned features ───┤ ← user-customizable; router.push to routes
 *   ├──── ⋯ More ───────────┤ ← overflow popover (non-pinned items + Customize)
 *   ├──── Teams (dynamic) ───┤ ← chat guilds (per-team conversation list)
 *   └────── Settings ────────┘
 *
 * Which items are pinned vs. in "More" (vs. hidden) is user customization
 * persisted on `settings.sidebarLayout` and resolved via `useSidebarLayout`.
 * Active state is computed from `usePathname()` for feature buttons and from
 * `selectedGuild` for chat buttons (when on `/`).
 *
 * Which edge it occupies is `settings.sidebarSide`. Everything that opens
 * sideways — tooltips, the "More" popover — has to open *inward*, so the side
 * is threaded down rather than hard-coded.
 */
export function GuildRail({
  onCreateTeam,
  onOpenSettings,
  variant = "rail",
  collapsed = false,
}: Props) {
  const t = useTranslations("desktop.guildRail")
  const listT = useTranslations("desktop.channelList")
  const pluginT = useTranslations()
  const teams = useClientLiveQuery<Team[]>(() => listTeams(), [], [])
  const {
    pathname,
    isDmActive,
    isCanvasActive,
    isTeamActive,
    isViewContainerActive,
    isFeatureActive,
    overflowActive,
    railContainers,
    layout: { resolved, pin, unpin, hide, side },
    switchToDm,
    switchToCanvas,
    switchToTeam,
    switchToViewContainer,
    goToFeature,
  } = useShellNav()
  const [moreOpen, setMoreOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  // An icon column has no room for the conversation rows, so each guild button
  // carries the count its section holds — the same aggregate the expanded
  // sidebar's closed rows show (`hooks/shell/use-guild-unread.ts`).
  const unread = useGuildUnread()
  const router = useRouter()
  /** "3 unread" — folded into each guild button's accessible name. */
  const unreadLabel = (count: number) => t("unreadCount", { count })
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
  const asideRef = useRef<HTMLElement | null>(null)
  // Reports the rail's *rendered* width, so the title bar's outlets track the
  // collapse frame for frame instead of jumping when it finishes. That is why
  // the width animates on the `<aside>` itself rather than on a wrapper: a
  // clipping wrapper would leave this measuring a full-width rail nobody can
  // see. See `stores/ui/shell-columns-store.ts`.
  useReportShellColumn("rail", asideRef)
  // Never collapse the Sheet's copy — there it is the drawer's leading column.
  const railCollapsed = variant === "rail" && collapsed
  const animatingCollapse = useEdgePanelTransition(railCollapsed, { element: asideRef })

  // Inside the mobile nav Sheet the rail is not on a window edge at all — it is
  // the drawer's leading column with the channel list to its right, so overlays
  // must open rightward regardless of the desktop preference.
  const effectiveSide: SidebarSide = variant === "sheet" ? "left" : side
  /** Where tooltips and the "More" popover open: inward, away from the edge. */
  const overlaySide = effectiveSide === "right" ? "left" : "right"

  const openOverflowItem = (route: string) => {
    setMoreOpen(false)
    goToFeature(route)
  }
  const openCustomize = () => {
    setMoreOpen(false)
    setCustomizeOpen(true)
  }
  const handleCreateTeam = () => {
    log.info("guild create team click")
    onCreateTeam()
  }
  const handleOpenSettings = () => {
    log.info("guild open settings")
    onOpenSettings()
  }

  return (
    <OverlaySideContext.Provider value={overlaySide}>
      <aside
        ref={asideRef}
        // Tint, no border — on the left. Shell chrome (this rail, the title bar,
        // the status bar) separates from content by its `bg-muted/40` tone alone;
        // stacking a border on top of a tone difference draws the seam twice.
        //
        // On the right the tone alone is not enough. The rail then abuts
        // `ContextWorkbench`, which declares the *same* `data-bg-target="sidebar"`
        // wallpaper scope (`context-workbench.tsx`) — with a background image on,
        // `background-applier.tsx` paints both from one scope and the seam
        // disappears entirely. The border is what keeps a 64px navigation rail
        // and a 48px activity rail from reading as one 112px column.
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
        aria-label={t("label")}
        data-variant={variant}
        data-side={effectiveSide}
        data-collapsed={railCollapsed || undefined}
        data-bg-target="sidebar"
        aria-hidden={railCollapsed || undefined}
        inert={railCollapsed || undefined}
      >
        {/* Fixed-width column: keeps the icons from being squeezed toward each
            other as the aside's width animates — they are clipped, not
            crushed. Mirrors the conversation sidebar's inner layer. */}
        <div className="flex h-full w-14 flex-col items-center py-2">
          <ScrollArea className="w-full flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden">
            <div className="flex flex-col items-center gap-2 px-2">
              <PluginExtensionSlot
                point="sidebar.left.top"
                className="flex flex-col items-center gap-2 empty:hidden"
              />
              <WorkspaceSwitcher />
              <Separator className="my-1 w-8" aria-label={t("workspacesGroup")} />
              <GuildContextMenu
                target={{ kind: "dm" }}
                unread={unread.dm}
                onNewConversation={() => startConversation(null)}
              >
                <RailButton
                  active={isDmActive}
                  ariaLabel={t("directMessages")}
                  tooltip={t("directMessages")}
                  onClick={switchToDm}
                  badge={unread.dm}
                  badgeLabel={unreadLabel}
                  testId="guild-dm"
                >
                  <MessagesSquareIcon className="size-5" />
                </RailButton>
              </GuildContextMenu>

              <RailButton
                active={isCanvasActive}
                ariaLabel={t("canvas")}
                tooltip={t("canvas")}
                onClick={switchToCanvas}
              >
                <PencilRulerIcon className="size-5" />
              </RailButton>

              {railContainers.map((c) => {
                const title = resolvePluginLabel(
                  pluginT as never,
                  c.pluginId,
                  c.def.titleKey,
                  c.def.title
                )
                return (
                  <RailButton
                    key={c.fullId}
                    active={isViewContainerActive(c.fullId)}
                    ariaLabel={title}
                    tooltip={title}
                    onClick={() => switchToViewContainer(c.fullId)}
                    testId={`guild-view-container-${c.fullId}`}
                  >
                    <ResolvedRailIcon name={c.def.icon} className="size-5" />
                  </RailButton>
                )
              })}

              <Separator className="my-1 w-8" aria-label={t("featuresGroup")} />

              {resolved.pinned.map((item) => (
                <NavRailButton
                  key={item.id}
                  item={item}
                  active={isFeatureActive(item.route)}
                  label={t(item.i18nKey)}
                  moveToMoreLabel={t("customize.moveToMore")}
                  hideLabel={t("customize.hideItem")}
                  customizeLabel={t("customize.title")}
                  onNavigate={() => goToFeature(item.route)}
                  onMoveToMore={() => void unpin(item.id)}
                  onHide={() => void hide(item.id)}
                  onCustomize={() => setCustomizeOpen(true)}
                />
              ))}

              {resolved.overflow.length > 0 && (
                <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("more")}
                      data-testid="guild-more"
                      className={cn(
                        "relative size-10 rounded-2xl transition-all hover:rounded-xl",
                        overflowActive
                          ? "rounded-xl text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {/* Same group as the rail buttons — "More" standing in for
                        an active overflow route is just another selection. */}
                      <MotionSelectionIndicator
                        groupId="guild-rail-selection"
                        active={overflowActive}
                        className="absolute inset-0 rounded-xl bg-primary/10"
                      />
                      <EllipsisIcon className="relative size-5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent side={overlaySide} align="start" className="w-56 p-1">
                    <div className="flex flex-col">
                      {resolved.overflow.map((item) => (
                        <div
                          key={item.id}
                          className={cn(
                            "flex items-center rounded hover:bg-accent",
                            isFeatureActive(item.route) && "bg-primary/10 text-foreground"
                          )}
                        >
                          <Button
                            variant="ghost"
                            onClick={() => openOverflowItem(item.route)}
                            data-testid={`guild-more-item-${item.id}`}
                            className="h-auto min-w-0 flex-1 justify-start rounded px-2 py-1.5 font-normal"
                          >
                            <item.Icon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-left">
                              {t(item.i18nKey)}
                            </span>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("customize.pinItem", { item: t(item.i18nKey) })}
                            data-testid={`guild-more-pin-${item.id}`}
                            onClick={() => void pin(item.id)}
                            className="mr-1 size-7 shrink-0"
                          >
                            <PinIcon className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                      <Separator className="my-1" />
                      <Button
                        variant="ghost"
                        onClick={openCustomize}
                        data-testid="guild-more-customize"
                        className="h-auto w-full justify-start rounded px-2 py-1.5 font-normal"
                      >
                        <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
                        <span className="flex-1 text-left">{t("customize.title")}</span>
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              <Separator className="my-1 w-8" />

              <ul className="flex flex-col items-center gap-2">
                {(teams ?? []).map((team) => (
                  <li key={team.id}>
                    <GuildContextMenu
                      target={{ kind: "team", teamId: team.id }}
                      unread={unread.teams.get(team.id) ?? 0}
                      onNewConversation={() => startConversation(team.id)}
                    >
                      <TeamButton
                        team={team}
                        active={isTeamActive(team.id)}
                        onSelect={() => switchToTeam(team.id)}
                        unread={unread.teams.get(team.id) ?? 0}
                        unreadLabel={unreadLabel}
                      />
                    </GuildContextMenu>
                  </li>
                ))}
                <li>
                  <RailButton
                    ariaLabel={t("createTeam")}
                    tooltip={t("createTeam")}
                    onClick={handleCreateTeam}
                    testId="guild-create-team"
                  >
                    <PlusIcon className="size-4" />
                  </RailButton>
                </li>
              </ul>
            </div>
          </ScrollArea>

          <Separator className="my-2 w-8" />

          <RailButton
            active={pathname === "/settings" || pathname.startsWith("/settings/")}
            ariaLabel={t("openSettings")}
            tooltip={t("settings")}
            onClick={handleOpenSettings}
            testId="guild-open-settings"
          >
            <SettingsIcon className="size-4" />
          </RailButton>

          <PluginExtensionSlot
            point="sidebar.left.bottom"
            className="mt-2 flex flex-col items-center gap-2 empty:hidden"
          />
        </div>

        <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="sidebar" />
      </aside>
    </OverlaySideContext.Provider>
  )
}

interface NavRailButtonProps {
  item: SidebarCatalogItem
  active: boolean
  label: string
  moveToMoreLabel: string
  hideLabel: string
  customizeLabel: string
  onNavigate: () => void
  onMoveToMore: () => void
  onHide: () => void
  onCustomize: () => void
}

/**
 * A pinned rail button with a right-click context menu offering quick
 * customization (move to "More", hide, open the full customizer). Wrapped in a
 * `div` so the `ContextMenuTrigger` has a single ref-forwarding child around the
 * tooltip-wrapped button.
 */
function NavRailButton({
  item,
  active,
  label,
  moveToMoreLabel,
  hideLabel,
  customizeLabel,
  onNavigate,
  onMoveToMore,
  onHide,
  onCustomize,
}: NavRailButtonProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <RailButton
            active={active}
            ariaLabel={label}
            tooltip={label}
            onClick={onNavigate}
            testId={`guild-feature-${item.id}`}
          >
            <item.Icon className="size-5" />
          </RailButton>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onMoveToMore}>
          <PinOffIcon className="size-4" />
          {moveToMoreLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onHide}>
          <EyeOffIcon className="size-4" />
          {hideLabel}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCustomize}>
          <SlidersHorizontalIcon className="size-4" />
          {customizeLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface RailButtonProps {
  active?: boolean
  ariaLabel: string
  tooltip: string
  onClick: () => void
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  testId?: string
  /**
   * Unread conversations behind this button. Drawn as a corner badge, and
   * folded into the accessible name — a screen reader gets "Alpha, 3 unread",
   * not a decorative pill it cannot see.
   */
  badge?: number
  badgeLabel?: (count: number) => string
}

function RailButton({
  active,
  ariaLabel,
  tooltip,
  onClick,
  children,
  className,
  style,
  testId,
  badge = 0,
  badgeLabel,
}: RailButtonProps) {
  const overlaySide = useContext(OverlaySideContext)
  const showBadge = badge > 0
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={showBadge && badgeLabel ? `${ariaLabel}, ${badgeLabel(badge)}` : ariaLabel}
          aria-current={active ? "page" : undefined}
          onClick={onClick}
          style={style}
          data-testid={testId}
          className={cn(
            "relative size-10 rounded-2xl transition-all hover:rounded-xl",
            active && "rounded-xl text-foreground",
            !active && "text-muted-foreground hover:text-foreground",
            className
          )}
        >
          {/* One group for the whole rail: at most one button is ever active
              (a guild only counts on `/`, a feature only off it), so the tint
              can travel the full column instead of blinking between sections. */}
          <MotionSelectionIndicator
            groupId="guild-rail-selection"
            active={Boolean(active)}
            className="absolute inset-0 rounded-xl bg-primary/10"
          />
          <span className="relative flex items-center justify-center">{children}</span>
          {showBadge ? (
            // Corner pill, outside the icon's optical square so it never sits
            // over the avatar's initial. `aria-hidden`: the count is already
            // in the button's accessible name above.
            <span
              aria-hidden
              data-testid={testId ? `${testId}-unread` : undefined}
              className="absolute -top-0.5 -right-0.5 min-w-4 rounded-pill bg-primary px-1 py-px text-[9px] leading-[14px] font-medium text-primary-foreground tabular-nums"
            >
              {badge > 99 ? "99+" : badge}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={overlaySide}>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function TeamButton({
  team,
  active,
  onSelect,
  unread = 0,
  unreadLabel,
}: {
  team: Team
  active: boolean
  onSelect: () => void
  unread?: number
  unreadLabel?: (count: number) => string
}) {
  return (
    <RailButton
      active={active}
      ariaLabel={team.name}
      tooltip={team.name}
      onClick={onSelect}
      badge={unread}
      badgeLabel={unreadLabel}
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
 * expanded sidebar's guild-row menu (`sidebar-guild-sections.tsx`), so the
 * same three actions are one gesture away in either state: start a
 * conversation there, mark the section read, manage teams.
 *
 * Wrapped in a `div` so the trigger has one ref-forwarding child around the
 * tooltip-wrapped button, the same shape `NavRailButton` uses.
 */
function GuildContextMenu({
  target,
  unread,
  onNewConversation,
  children,
}: {
  target: GuildUnreadTarget
  unread: number
  onNewConversation?: () => void
  children: React.ReactNode
}) {
  const t = useTranslations("desktop.guildRail")
  const listT = useTranslations("desktop.channelList")
  const router = useRouter()
  const isDm = target.kind === "dm"
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid={`guild-menu-${isDm ? "dm" : target.teamId}`}>
        {onNewConversation ? (
          <ContextMenuItem
            onSelect={() => {
              log.info("guild new conversation via rail menu", target)
              onNewConversation()
            }}
            data-testid={`guild-menu-new-${isDm ? "dm" : target.teamId}`}
          >
            <PlusIcon className="size-4" />
            {isDm ? listT("newChat") : listT("newConversation")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          disabled={unread === 0}
          onSelect={() => {
            log.info("guild mark read", target)
            void markGuildRead(target).catch((error: unknown) => {
              log.warn("guild mark read failed", { error: String(error) })
            })
          }}
          data-testid={`guild-menu-mark-read-${isDm ? "dm" : target.teamId}`}
        >
          <CheckCheckIcon className="size-4" />
          {t("markAllRead")}
        </ContextMenuItem>
        {isDm ? null : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => {
                log.info("guild manage teams")
                router.push(TEAM_SETTINGS_ROUTE)
              }}
              data-testid={`guild-menu-manage-${target.teamId}`}
            >
              <SettingsIcon className="size-4" />
              {t("manageTeams")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
