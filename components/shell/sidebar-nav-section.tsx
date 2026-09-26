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
 * Everything but the markup — labels, counts, chords, the reorder / hide /
 * pin handlers, the "More" and customizer state — comes from
 * `useShellNavModel`, and each row's right-click menu is the rail's own
 * (`nav-item-menu.tsx`). Each block is ordered by the same layout the rail
 * reads: drag a row, or use "Move up / Move down" in its context menu. A feature row carries the
 * rail's live count (`lib/shell/nav-badges.ts`) at its trailing end and its
 * ⌥N chord in its tooltip.
 *
 * Direct Messages and the teams are not here — they are the accordion
 * sections beneath (`sidebar-guild-sections.tsx`), because they own the list.
 */

import type { ComponentPropsWithRef, ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, EllipsisIcon, PencilRulerIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { CountPill } from "@/components/shared/count-pill"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { MoreMenuContent } from "./more-menu"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { ResolvedRailIcon } from "@/components/shell/plugin-view-container-panel"
import { navBadgeCount } from "@/lib/shell/nav-badges"
import { NavItemContextMenu } from "./nav-item-menu"
import { NavSortableItem, NavSortableList } from "./nav-sortable"
import { overlaySideFor } from "./rail-overlay-side"
import { ShellLayoutDialog } from "./shell-layout-dialog"
import { useSidebarRowRoving } from "./sidebar-row-roving"
import { useShellNavModel } from "./use-shell-nav"

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

export function SidebarNavSection({ className }: { className?: string }) {
  const t = useTranslations("desktop.guildRail")
  const commonT = useTranslations("common")
  const {
    pendingRoute,
    isFeatureActive,
    overflowActive,
    modes,
    layout: { resolved, side },
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
  // The sidebar docks on the same edge the rail would, so its popovers open
  // the same inward way.
  const overlaySide = overlaySideFor(side)

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
            return (
              <NavSortableItem key={mode.id} id={mode.id}>
                {(drag) => (
                  <NavItemContextMenu
                    drag={drag}
                    menuTestId={`${testId}-menu`}
                    {...modeMenu(mode, index)}
                  >
                    <SidebarRow
                      active={isModeActive(mode)}
                      onClick={() => selectMode(mode)}
                      icon={
                        isModePending(mode) ? (
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
                  </NavItemContextMenu>
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
        <NavSortableList ids={pinnedIds} onReorder={reorderPinnedIds} labelOf={pinnedLabelById}>
          {resolved.pinned.map((item, index) => {
            const label = pinnedLabel(item)
            const count = navBadgeCount(badges, item.id)
            const shortcut = pinnedShortcuts[index]
            const testId = `sidebar-nav-feature-${item.id}`
            return (
              <NavSortableItem key={item.id} id={item.id}>
                {(drag) => (
                  <NavItemContextMenu
                    drag={drag}
                    menuTestId={`${testId}-menu`}
                    {...pinnedMenu(item, index)}
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
                          <CountPill count={count} testId={`${testId}-badge`} />
                        ) : undefined
                      }
                      testId={testId}
                    />
                  </NavItemContextMenu>
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
                onPin={pinItem}
                onHide={hideItem}
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
