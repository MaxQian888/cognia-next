"use client"

/**
 * The shell navigation as labelled rows — the expanded sidebar's top block.
 *
 * Same destinations as the 56px icon column (`guild-rail.tsx`), read from the
 * same `useShellNav`; only the rendering differs: an icon+label row per entry
 * instead of a tooltip'd square. Order and grouping mirror the rail so the
 * two states of the sidebar feel like one thing folding and unfolding:
 *
 *   Canvas · plugin view containers          ← workspace modes (chat guilds)
 *   ─────
 *   pinned features (right-click to customize) · More…
 *
 * Each block is ordered by the same layout the rail reads: drag a row, or
 * use "Move up / Move down" in its context menu. A feature row carries the
 * rail's live count (`lib/shell/nav-badges.ts`) at its trailing end and its
 * ⌥N chord in its tooltip.
 *
 * Direct Messages and the teams are not here — they are the accordion
 * sections beneath (`sidebar-guild-sections.tsx`), because they own the list.
 */

import { useCallback, useMemo, useState, type ComponentPropsWithRef, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  EllipsisIcon,
  EyeOffIcon,
  PencilRulerIcon,
  PinOffIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { MoreMenuContent } from "./more-menu"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { ResolvedRailIcon } from "@/components/shell/plugin-view-container-panel"
import { useNavBadges } from "@/hooks/shell/use-nav-badges"
import { useAppShortcutLabels } from "@/hooks/shortcuts/use-app-shortcut-label"
import { PINNED_NAV_SHORTCUT_IDS } from "@/lib/shortcuts/app-catalog"
import { navBadgeCount, sumNavBadges } from "@/lib/shell/nav-badges"
import { mergeVisibleModeOrder, moveVisibleMode } from "@/lib/shell/sidebar-nav"
import { NavSortableItem, NavSortableList, type NavDragBinding } from "./nav-sortable"
import { overlaySideFor } from "./rail-overlay-side"
import { ShellLayoutDialog } from "./shell-layout-dialog"
import { useSidebarRowRoving } from "./sidebar-row-roving"
import { useShellNav, type ShellMode } from "./use-shell-nav"

/** One highlight travels between every row of the expanded sidebar. */
export const SIDEBAR_SELECTION_GROUP = "sidebar-nav-selection"

export interface SidebarRowProps extends Omit<
  ComponentPropsWithRef<"button">,
  "children" | "onClick"
> {
  active?: boolean
  onClick?: () => void
  /**
   * Draw the travelling selection tint behind an active row. Off for rows
   * whose "active" is *open* rather than *selected* (the guild accordion
   * headers): those read as headings — bold, no fill — not as a choice.
   */
  highlight?: boolean
  /** Before the icon slot: a disclosure chevron for collapsible rows. */
  leading?: ReactNode
  /** Leading glyph — an icon, an avatar, a chevron. */
  icon: ReactNode
  label: string
  /** Trailing content (count, chevron), drawn after the label. */
  trailing?: ReactNode
  /** Sets `aria-current="page"` when active; `false` for pure toggles. */
  current?: boolean
  testId?: string
}

/**
 * The sidebar's row: 28px, icon + label, the shared travelling highlight
 * behind it. Used by the nav section, the guild accordion headers and the
 * footer so all three read as one list. Rest props (and `ref`) reach the
 * button, so it can be a Radix `asChild` trigger directly.
 */
export function SidebarRow({
  active = false,
  onClick,
  highlight = true,
  leading,
  icon,
  label,
  trailing,
  current = true,
  className,
  testId,
  ...rest
}: SidebarRowProps) {
  // One tab stop for the whole sidebar, arrows between rows — but only inside
  // a `SidebarRowsScope`; elsewhere (the icon column, the mobile Sheet) this
  // reports `inScope: false` and the row keeps its plain behaviour.
  const roving = useSidebarRowRoving(testId, active)
  return (
    <Button
      type="button"
      variant="ghost"
      {...rest}
      {...roving.rowProps}
      tabIndex={rest.tabIndex ?? roving.tabIndex}
      onKeyDown={(event) => {
        rest.onKeyDown?.(event)
        if (!event.defaultPrevented) roving.onKeyDown?.(event)
      }}
      onFocus={(event) => {
        rest.onFocus?.(event)
        roving.onFocus?.()
      }}
      onClick={onClick}
      aria-current={active && current ? "page" : undefined}
      data-active={active || undefined}
      data-testid={testId}
      className={cn(
        "relative h-7 w-full min-w-0 justify-start gap-2.5 rounded-md px-2 text-[13px] font-normal",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        className
      )}
    >
      <MotionSelectionIndicator
        groupId={SIDEBAR_SELECTION_GROUP}
        active={active && highlight}
        className="absolute inset-0 rounded-md bg-primary/10"
      />
      {leading ? (
        <span className="relative -ml-0.5 flex size-4 shrink-0 items-center justify-center [&>svg]:size-3.5">
          {leading}
        </span>
      ) : null}
      <span className="relative flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">
        {icon}
      </span>
      <span className="relative min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ? <span className="relative flex shrink-0 items-center">{trailing}</span> : null}
    </Button>
  )
}

/**
 * The sidebar's compact count pill — a guild's unread conversations
 * (`GuildUnreadPill` in `sidebar-guild-sections.tsx`) or a feature's waiting
 * items. Plain text, so a row without an explicit `aria-label` reads its
 * count as part of its name.
 */
export function CountPill({ count, testId }: { count: number; testId?: string }) {
  if (count <= 0) return null
  return (
    <span
      className="shrink-0 rounded-pill bg-primary px-1.5 py-0.5 text-[10px] leading-none font-medium text-primary-foreground tabular-nums"
      data-testid={testId}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

export function SidebarNavSection({ className }: { className?: string }) {
  const t = useTranslations("desktop.guildRail")
  const pluginT = useTranslations()
  const commonT = useTranslations("common")
  const {
    pendingRoute,
    selected,
    isCanvasActive,
    isViewContainerActive,
    isFeatureActive,
    overflowActive,
    modes,
    layout: { resolved, pin, unpin, hide, side, reorderPinned, movePinned, hideMode, reorderModes },
    switchToCanvas,
    switchToViewContainer,
    goToFeature,
  } = useShellNav()
  const [moreOpen, setMoreOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const overflowPending = resolved.overflow.some((item) => item.route === pendingRoute)
  const badges = useNavBadges()
  const overflowBadge = sumNavBadges(
    badges,
    resolved.overflow.map((item) => item.id)
  )
  const pinnedShortcuts = useAppShortcutLabels(PINNED_NAV_SHORTCUT_IDS)
  // The sidebar docks on the same edge the rail would, so its popovers open
  // the same inward way.
  const overlaySide = overlaySideFor(side)

  const openOverflowItem = (route: string) => {
    setMoreOpen(false)
    goToFeature(route)
  }
  const openCustomize = () => {
    setMoreOpen(false)
    setCustomizeOpen(true)
  }

  const modeLabel = useCallback(
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
  const visibleModeIds = useMemo(() => modes.visible.map((mode) => mode.id), [modes.visible])
  const pinnedIds = useMemo(() => resolved.pinned.map((item) => item.id), [resolved.pinned])
  const modeLabelById = useCallback(
    (id: string) => {
      const mode = modes.visible.find((entry) => entry.id === id)
      return mode ? modeLabel(mode) : id
    },
    [modes.visible, modeLabel]
  )
  const pinnedLabelById = useCallback(
    (id: string) => {
      const item = resolved.pinned.find((entry) => entry.id === id)
      return item ? t(item.i18nKey) : id
    },
    [resolved.pinned, t]
  )
  // Both write the whole stored order, hidden modes included, so a hidden
  // mode keeps its slot instead of being pushed to the end.
  const modeOrderIds = useMemo(() => modes.order.map((mode) => mode.id), [modes.order])
  const hiddenModeIds = useMemo(() => new Set(modes.hidden.map((mode) => mode.id)), [modes.hidden])
  const reorderVisibleModes = (visibleOrder: string[]) =>
    void reorderModes(mergeVisibleModeOrder(modeOrderIds, hiddenModeIds, visibleOrder))
  const moveMode = (id: string, delta: number) => {
    const next = moveVisibleMode(modeOrderIds, hiddenModeIds, id, delta)
    if (next) void reorderModes(next)
  }

  return (
    <nav
      aria-label={t("navigation")}
      data-testid="sidebar-nav"
      className={cn("flex shrink-0 flex-col gap-px px-2 py-1", className)}
    >
      {pendingRoute ? (
        <span role="status" className="sr-only">
          {commonT("loading")}
        </span>
      ) : null}
      {/* Declared form factor is `icon` (`lib/plugin/contracts/plugin-points.ts`)
          — square controls with no room for a label — so contributions get an
          icon strip here too, not a column of label rows they never sized for. */}
      <PluginExtensionSlot
        point="sidebar.left.top"
        className="flex flex-wrap items-center gap-1 pb-1 empty:hidden"
      />
      <div role="group" aria-label={t("workspacesGroup")} className="flex flex-col gap-px">
        <NavSortableList
          ids={visibleModeIds}
          onReorder={reorderVisibleModes}
          labelOf={modeLabelById}
        >
          {modes.visible.map((mode, index) => {
            const isCanvas = mode.kind === "canvas"
            const testId = isCanvas ? "sidebar-nav-canvas" : `sidebar-nav-view-container-${mode.id}`
            const pending =
              pendingRoute === "/" &&
              (isCanvas
                ? selected.kind === "canvas"
                : selected.kind === "plugin-view" && selected.containerId === mode.id)
            return (
              <NavSortableItem key={mode.id} id={mode.id}>
                {(drag) => (
                  <NavRowMenu
                    drag={drag}
                    testId={testId}
                    canMoveUp={index > 0}
                    canMoveDown={index < modes.visible.length - 1}
                    onMove={(delta) => moveMode(mode.id, delta)}
                    onHide={() => void hideMode(mode.id)}
                    onCustomize={() => setCustomizeOpen(true)}
                  >
                    <SidebarRow
                      active={isCanvas ? isCanvasActive : isViewContainerActive(mode.id)}
                      onClick={() => (isCanvas ? switchToCanvas() : switchToViewContainer(mode.id))}
                      icon={
                        pending ? (
                          <Spinner />
                        ) : isCanvas ? (
                          <PencilRulerIcon />
                        ) : (
                          <ResolvedRailIcon name={mode.container.def.icon} className="size-4" />
                        )
                      }
                      label={modeLabel(mode)}
                      testId={testId}
                    />
                  </NavRowMenu>
                )}
              </NavSortableItem>
            )
          })}
        </NavSortableList>
      </div>

      {resolved.pinned.length > 0 || resolved.overflow.length > 0 ? (
        <Separator className="my-1" />
      ) : null}

      <div role="group" aria-label={t("featuresGroup")} className="flex flex-col gap-px">
        <NavSortableList
          ids={pinnedIds}
          onReorder={(ids) => void reorderPinned(ids)}
          labelOf={pinnedLabelById}
        >
          {resolved.pinned.map((item, index) => {
            const label = t(item.i18nKey)
            const count = navBadgeCount(badges, item.id)
            const shortcut = pinnedShortcuts[index]
            return (
              <NavSortableItem key={item.id} id={item.id}>
                {(drag) => (
                  <NavRowMenu
                    drag={drag}
                    testId={`sidebar-nav-feature-${item.id}`}
                    canMoveUp={index > 0}
                    canMoveDown={index < resolved.pinned.length - 1}
                    onMove={(delta) => void movePinned(item.id, delta)}
                    onMoveToMore={() => void unpin(item.id)}
                    onHide={() => void hide(item.id)}
                    onCustomize={() => setCustomizeOpen(true)}
                  >
                    <SidebarRow
                      active={isFeatureActive(item.route)}
                      onClick={() => goToFeature(item.route)}
                      aria-busy={pendingRoute === item.route}
                      aria-label={count > 0 ? `${label}, ${t("badgeCount", { count })}` : undefined}
                      aria-keyshortcuts={shortcut?.aria}
                      title={
                        shortcut?.label
                          ? t("shortcutHint", { label, shortcut: shortcut.label })
                          : label
                      }
                      icon={pendingRoute === item.route ? <Spinner /> : <item.Icon />}
                      label={label}
                      trailing={
                        count > 0 ? (
                          <CountPill
                            count={count}
                            testId={`sidebar-nav-feature-${item.id}-badge`}
                          />
                        ) : undefined
                      }
                      testId={`sidebar-nav-feature-${item.id}`}
                    />
                  </NavRowMenu>
                )}
              </NavSortableItem>
            )
          })}
        </NavSortableList>

        {resolved.overflow.length > 0 ? (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <SidebarRow
                active={overflowActive}
                aria-busy={overflowPending}
                aria-label={
                  overflowBadge > 0
                    ? `${t("more")}, ${t("badgeCount", { count: overflowBadge })}`
                    : undefined
                }
                icon={overflowPending ? <Spinner /> : <EllipsisIcon />}
                label={t("more")}
                trailing={
                  <>
                    {overflowBadge > 0 ? (
                      <span
                        aria-hidden
                        data-testid="sidebar-nav-more-badge"
                        className="me-1 size-1.5 rounded-full bg-primary"
                      />
                    ) : null}
                    <ChevronRightIcon
                      className={cn(
                        "size-3.5 text-muted-foreground/70",
                        overlaySide === "left" && "rotate-180"
                      )}
                    />
                  </>
                }
                current={false}
                testId="sidebar-nav-more"
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
                onPin={(id) => void pin(id)}
                onHide={(id) => void hide(id)}
                onCustomize={openCustomize}
                testIdPrefix="sidebar-nav-more"
              />
            </PopoverContent>
          </Popover>
        ) : null}
      </div>

      <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="sidebar" />
    </nav>
  )
}

/**
 * Context menu + drag handle around one hosted nav row. The `div` is both the
 * `ContextMenuTrigger`'s single child and the element dnd-kit moves.
 * `onMoveToMore` is only for pinned features — a workspace mode has no "More".
 */
function NavRowMenu({
  drag: { setNodeRef, style: dragStyle, dragging, handleProps },
  testId,
  canMoveUp,
  canMoveDown,
  onMove,
  onMoveToMore,
  onHide,
  onCustomize,
  children,
}: {
  drag: NavDragBinding
  testId: string
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (delta: number) => void
  onMoveToMore?: () => void
  onHide: () => void
  onCustomize: () => void
  children: ReactNode
}) {
  const t = useTranslations("desktop.guildRail")
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={dragStyle}
          {...handleProps}
          className={cn(dragging && "relative z-10 opacity-50")}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid={`${testId}-menu`}>
        <ContextMenuItem
          disabled={!canMoveUp}
          onSelect={() => onMove(-1)}
          data-testid={`${testId}-menu-move-up`}
        >
          <ArrowUpIcon className="size-4" />
          {t("moveTeamUp")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canMoveDown}
          onSelect={() => onMove(1)}
          data-testid={`${testId}-menu-move-down`}
        >
          <ArrowDownIcon className="size-4" />
          {t("moveTeamDown")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {onMoveToMore ? (
          <ContextMenuItem onSelect={onMoveToMore} data-testid={`${testId}-menu-unpin`}>
            <PinOffIcon className="size-4" />
            {t("customize.moveToMore")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={onHide} data-testid={`${testId}-menu-hide`}>
          <EyeOffIcon className="size-4" />
          {t("customize.hideItem")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCustomize}>
          <SlidersHorizontalIcon className="size-4" />
          {t("customize.title")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
