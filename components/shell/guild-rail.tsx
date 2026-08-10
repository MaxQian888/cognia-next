"use client"

import { createContext, useContext, useState, useSyncExternalStore } from "react"
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
import { avatarColor } from "@/lib/ui/avatar"
import { listTeams } from "@/lib/db/teams"
import { loggers } from "@cognia/logging"
import { useClientLiveQuery } from "@/hooks/data"
import { useUIStore } from "@/stores/ui"
import type { Team } from "@cognia/agent-config-types"
import {
  EllipsisIcon,
  EyeOffIcon,
  MailIcon,
  PencilRulerIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { usePathname, useRouter } from "next/navigation"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { ResolvedRailIcon } from "@/components/shell/plugin-view-container-panel"
import {
  getViewContainerSnapshot,
  subscribeViewContainers,
} from "@/lib/plugin/registries/view-container-registry"
import {
  evaluateContextWhen,
  getContextKeyRevision,
  subscribeContextKeys,
} from "@/lib/plugin/context-keys/context-key-store"
import { useSidebarLayout } from "./use-sidebar-layout"
import { ShellLayoutDialog } from "./shell-layout-dialog"
import { WorkspaceSwitcher } from "./workspace-switcher"
import type { SidebarCatalogItem } from "@/lib/shell/sidebar-nav"
import type { SidebarSide } from "@/types/shell/sidebar"

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
}

/**
 * The 64px-wide navigation rail. Discord-style top-level navigation extended
 * with route-aware feature buttons.
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
export function GuildRail({ onCreateTeam, onOpenSettings, variant = "rail" }: Props) {
  const t = useTranslations("desktop.guildRail")
  const pluginT = useTranslations()
  const router = useRouter()
  const pathname = usePathname() ?? "/"
  const selected = useUIStore((s) => s.selectedGuild)
  const setSelected = useUIStore((s) => s.setSelectedGuild)
  const teams = useClientLiveQuery<Team[]>(() => listTeams(), [], [])
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
  const { resolved, pin, unpin, hide, side } = useSidebarLayout()
  const [moreOpen, setMoreOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)

  // Inside the mobile nav Sheet the rail is not on a window edge at all — it is
  // the drawer's leading column with the channel list to its right, so overlays
  // must open rightward regardless of the desktop preference.
  const effectiveSide: SidebarSide = variant === "sheet" ? "left" : side
  /** Where tooltips and the "More" popover open: inward, away from the edge. */
  const overlaySide = effectiveSide === "right" ? "left" : "right"

  const onHomeRoute = pathname === "/"
  const isDmActive = onHomeRoute && selected.kind === "dm"
  const isCanvasActive = onHomeRoute && selected.kind === "canvas"

  const isFeatureActive = (route: string) => pathname === route || pathname.startsWith(route + "/")
  const overflowActive = resolved.overflow.some((item) => isFeatureActive(item.route))

  const switchToDm = () => {
    log.info("guild switch dm")
    setSelected({ kind: "dm" })
    if (!onHomeRoute) router.push("/")
  }
  const switchToCanvas = () => {
    log.info("guild switch canvas")
    setSelected({ kind: "canvas" })
    if (!onHomeRoute) router.push("/")
  }
  const switchToTeam = (teamId: string) => {
    log.info("guild switch team", { teamId })
    setSelected({ kind: "team", teamId })
    if (!onHomeRoute) router.push("/")
  }
  const switchToViewContainer = (containerId: string) => {
    log.info("guild switch plugin-view", { containerId })
    setSelected({ kind: "plugin-view", containerId })
    if (!onHomeRoute) router.push("/")
  }
  const goToFeature = (route: string) => {
    log.info("guild navigate feature", { route })
    router.push(route)
  }
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
          "h-full w-16 shrink-0 flex-col items-center bg-muted/40 py-2",
          effectiveSide === "right" && "border-l",
          variant === "sheet" ? "flex" : "hidden md:flex"
        )}
        aria-label={t("label")}
        data-variant={variant}
        data-side={effectiveSide}
        data-bg-target="sidebar"
      >
        <ScrollArea className="w-full flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden">
          <div className="flex flex-col items-center gap-2 px-2">
            <PluginExtensionSlot
              point="sidebar.left.top"
              className="flex flex-col items-center gap-2 empty:hidden"
            />
            <WorkspaceSwitcher />
            <Separator className="my-1 w-8" aria-label={t("workspacesGroup")} />
            <RailButton
              active={isDmActive}
              ariaLabel={t("directMessages")}
              tooltip={t("directMessages")}
              onClick={switchToDm}
            >
              <MailIcon className="size-5" />
            </RailButton>

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
                  active={
                    onHomeRoute &&
                    selected.kind === "plugin-view" &&
                    selected.containerId === c.fullId
                  }
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
                  <TeamButton
                    team={team}
                    active={onHomeRoute && selected.kind === "team" && selected.teamId === team.id}
                    onSelect={() => switchToTeam(team.id)}
                  />
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
}: RailButtonProps) {
  const overlaySide = useContext(OverlaySideContext)
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={ariaLabel}
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
}: {
  team: Team
  active: boolean
  onSelect: () => void
}) {
  return (
    <RailButton
      active={active}
      ariaLabel={team.name}
      tooltip={team.name}
      onClick={onSelect}
      className="text-base"
      style={active ? { boxShadow: `inset 0 0 0 2px ${avatarColor(team)}` } : undefined}
    >
      <AvatarBadge subject={team} size={28} textClassName="text-sm" />
    </RailButton>
  )
}
