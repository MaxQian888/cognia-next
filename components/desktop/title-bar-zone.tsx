"use client"

/**
 * Renders one zone of the title bar from the user's resolved layout.
 *
 * Counterpart to `status-bar-zone.tsx`. The title bar's segments need a little
 * state that only `TitleBar` has (the app name strings, the command-palette
 * handler, the recent-session list), so the bar passes it down as `ctx` rather
 * than each segment re-deriving it.
 *
 * Not routed through here, because they are structural rather than
 * customizable: the Tauri drag regions, the Windows/Linux menubar, the
 * min/max/close cluster, and the `toolbar.*` plugin extension slots.
 */

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { EllipsisIcon, SparklesIcon } from "lucide-react"

import { AccountBarButton } from "@/components/account/account-bar-button"
import { TitleBarCommandCenterMenu } from "@/components/desktop/title-bar-command-center-menu"
import type { RecentSessionEntry } from "@/components/desktop/title-bar-command-center-menu"
import { TitleBarLayoutControls } from "@/components/desktop/title-bar-layout-controls"
import { TitleBarNavArrows } from "@/components/desktop/title-bar-nav-arrows"
import { TitleBarQuickActions } from "@/components/desktop/title-bar-quick-actions"
import { TitleBarSearchPill } from "@/components/desktop/title-bar-search-pill"
import { TitleBarWorkspace } from "@/components/desktop/title-bar-workspace"
import type { MenuActionId } from "@/lib/desktop/menu-actions"
import type { BarCatalogItem } from "@/lib/shell/bar-items"
import type { BarItemMinWidth } from "@/types/shell/bars"

/** Everything a title-bar segment can need from the bar that hosts it. */
export interface TitleBarItemContext {
  appName: string
  separator: string
  searchPlaceholder: string
  kbdHint: string
  recentSessions: RecentSessionEntry[]
  onCommandPalette: () => void
  onOpenRecentSession: (sessionId: string) => void
  onGo: (id: MenuActionId) => void
}

/**
 * Viewport floor → Tailwind classes. This is what keeps a fully-populated bar
 * from clipping its trailing controls on a narrow window: the low-priority
 * segments drop out before the row runs out of room. `inline` picks the
 * inline-flex variant for segments that sit inside a text run.
 */
function minWidthClass(minWidth: BarItemMinWidth | undefined, inline = false): string {
  if (!minWidth) return ""
  const shown = inline ? "inline-flex" : "flex"
  return minWidth === "xl" ? `hidden xl:${shown}` : `hidden lg:${shown}`
}

export function TitleBarZone({
  items,
  ctx,
  compact = false,
}: {
  items: BarCatalogItem[]
  ctx: TitleBarItemContext
  compact?: boolean
}) {
  const t = useTranslations("desktop")
  const visible = compact ? items.filter((item) => item.id === "search") : items
  const folded = compact ? items.filter((item) => item.id !== "search") : []
  return (
    <>
      {visible.map((item) => (
        <TitleBarSegment key={item.id} item={item} ctx={ctx} compact={compact} />
      ))}
      {folded.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label={t("titleBar.navigationMenu")}
              title={t("titleBar.navigationMenu")}
              data-testid="title-bar-navigation-menu"
            >
              <EllipsisIcon className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-64 space-y-3"
            aria-label={t("titleBar.navigationMenu")}
          >
            {folded.map((item) => (
              <div key={item.id} className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {t(`barCustomize.items.${item.i18nKey}`)}
                </p>
                <div className="flex min-w-0 items-center gap-1">
                  <TitleBarSegment item={{ ...item, minWidth: undefined }} ctx={ctx} />
                </div>
              </div>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}

function TitleBarSegment({
  item,
  ctx,
  compact = false,
}: {
  item: BarCatalogItem
  ctx: TitleBarItemContext
  compact?: boolean
}) {
  switch (item.id) {
    case "appIcon":
      return (
        <SparklesIcon
          aria-hidden
          data-testid="title-bar-app-icon"
          className="size-4 shrink-0 text-primary"
        />
      )
    case "navArrows":
      return <TitleBarNavArrows className="shrink-0" />
    case "workspace":
      return <TitleBarWorkspace className={`shrink-0 ${minWidthClass(item.minWidth)}`} />
    case "search":
      return (
        <TitleBarSearchPill
          compact={compact}
          appName={ctx.appName}
          separator={ctx.separator}
          placeholder={ctx.searchPlaceholder}
          kbdHint={ctx.kbdHint}
          onClick={ctx.onCommandPalette}
        />
      )
    case "commandCenter":
      return (
        <TitleBarCommandCenterMenu
          className={minWidthClass(item.minWidth, true)}
          recentSessions={ctx.recentSessions}
          onCommandPalette={ctx.onCommandPalette}
          onOpenRecentSession={ctx.onOpenRecentSession}
          onGo={ctx.onGo}
        />
      )
    case "quickActions":
      return <TitleBarQuickActions className={minWidthClass(item.minWidth)} />
    case "accountTop":
      return <AccountBarButton className="mx-0.5" />
    case "primarySidebarToggle":
      return <TitleBarLayoutControls controls={["sidebar"]} />
    case "panelToggle":
      return <TitleBarLayoutControls controls={["panel"]} />
    case "secondarySidebarToggle":
      return <TitleBarLayoutControls controls={["rightSidebar"]} />
    case "layoutControls":
      return <TitleBarLayoutControls className="px-1" controls={["customize"]} />
    default:
      // Unreachable for catalog ids — `title-bar-zone.test.tsx` pins that every
      // entry in `TITLE_BAR_ITEMS` has a case above.
      return null
  }
}
