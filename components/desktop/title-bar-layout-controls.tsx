"use client"

/**
 * VSCode-style layout control cluster for the desktop title bar.
 *
 * Surfaces the panel toggles that previously lived only inside the View menu
 * as one-click icon buttons (wide screens) plus a "Customize Layout" dropdown
 * (always present) — mirroring VSCode's title-bar layout controls.
 *
 * Subscribes to the layout stores internally so the title bar's menubar tree
 * stays render-stable (same pattern as `TitleBarSearchPill`).
 */

import { Columns2Icon, LayoutDashboardIcon, PanelBottomIcon, PanelLeftIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toggleGuildRailAction, toggleStatusBarAction } from "@/lib/desktop/menu-actions"
import { cn } from "@/lib/utils"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useUIStore, type BarItemId } from "@/stores/ui/ui-store"

/** Optional bar segments grouped by which bar they live in. Label keys resolve
 *  under `desktop.titleBar.layout.*`. Rendered as checkboxes in the Customize
 *  Layout dropdown so the user can hide any segment they don't want. */
const STATUS_BAR_ITEMS: { id: BarItemId; labelKey: string }[] = [
  { id: "connectivity", labelKey: "itemConnectivity" },
  { id: "sync", labelKey: "itemSync" },
  { id: "perf", labelKey: "itemPerf" },
  { id: "accountStatus", labelKey: "itemAccount" },
  { id: "usage", labelKey: "itemUsage" },
]
const TITLE_BAR_ITEMS: { id: BarItemId; labelKey: string }[] = [
  { id: "accountTop", labelKey: "itemAccount" },
  { id: "workspace", labelKey: "itemWorkspace" },
  { id: "quickActions", labelKey: "itemQuickActions" },
]

// Mirror of the title bar's popover perf override (kept local to avoid an
// import cycle with title-bar.tsx): kill the enter/exit keyframes that repaint
// large areas on Windows WebView2; keep a light shadow. No `will-change`/
// transform — it would establish a containing block that clips Radix's
// fixed-positioned submenu content under the parent's `overflow-hidden`.
const MENU_CONTENT_PERF =
  "data-[state=open]:!animate-none data-[state=closed]:!animate-none shadow-sm"

function LayoutToggleButton({
  label,
  testId,
  active,
  onClick,
  children,
}: {
  label: string
  testId: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "h-7 w-7 rounded-sm transition-colors hover:text-foreground",
        "motion-safe:transition-transform motion-safe:active:scale-90",
        active ? "text-foreground" : "text-muted-foreground"
      )}
    >
      {children}
    </Button>
  )
}

export function TitleBarLayoutControls({ className }: { className?: string }) {
  const t = useTranslations("desktop.titleBar.layout")

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const guildRailCollapsed = useUIStore((s) => s.guildRailCollapsed)
  const statusBarCollapsed = useUIStore((s) => s.statusBarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const barItems = useUIStore((s) => s.barItems)
  const toggleBarItem = useUIStore((s) => s.toggleBarItem)
  const terminalOpen = useTerminalStore((s) => s.panelOpen)
  const toggleTerminal = useTerminalStore((s) => s.togglePanel)

  const sidebarOn = !sidebarCollapsed
  const guildRailOn = !guildRailCollapsed
  const statusBarOn = !statusBarCollapsed

  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
      data-testid="title-bar-layout-controls"
    >
      {/* Quick buttons — collapse below xl into the Customize dropdown. */}
      <div className="hidden items-center gap-0.5 xl:flex">
        <LayoutToggleButton
          label={t("toggleGuildRail")}
          testId="title-bar-toggle-guild-rail"
          active={guildRailOn}
          onClick={() => toggleGuildRailAction()}
        >
          <Columns2Icon className="size-4" aria-hidden />
        </LayoutToggleButton>
        <LayoutToggleButton
          label={t("toggleSidebar")}
          testId="title-bar-toggle-sidebar"
          active={sidebarOn}
          onClick={toggleSidebar}
        >
          <PanelLeftIcon className="size-4" aria-hidden />
        </LayoutToggleButton>
        <LayoutToggleButton
          label={t("toggleTerminal")}
          testId="title-bar-toggle-terminal"
          active={terminalOpen}
          onClick={toggleTerminal}
        >
          <PanelBottomIcon className="size-4" aria-hidden />
        </LayoutToggleButton>
      </div>

      {/* Customize Layout dropdown — always present (sole control < xl). */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-testid="title-bar-customize-layout"
            aria-label={t("customize")}
            title={t("customize")}
            className={cn(
              "h-7 w-7 rounded-sm text-muted-foreground transition-colors hover:text-foreground",
              "motion-safe:transition-transform motion-safe:active:scale-90"
            )}
          >
            <LayoutDashboardIcon className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={cn("w-52", MENU_CONTENT_PERF)}>
          <DropdownMenuLabel>{t("title")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={guildRailOn}
            onCheckedChange={() => toggleGuildRailAction()}
          >
            {t("toggleGuildRail")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={sidebarOn} onCheckedChange={() => toggleSidebar()}>
            {t("toggleSidebar")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarOn}
            onCheckedChange={() => toggleStatusBarAction()}
          >
            {t("toggleStatusBar")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={terminalOpen} onCheckedChange={() => toggleTerminal()}>
            {t("toggleTerminal")}
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("statusBarGroup")}</DropdownMenuLabel>
          {STATUS_BAR_ITEMS.map(({ id, labelKey }) => (
            <DropdownMenuCheckboxItem
              key={id}
              checked={barItems[id]}
              onCheckedChange={() => toggleBarItem(id)}
              data-testid={`title-bar-item-${id}`}
            >
              {t(labelKey)}
            </DropdownMenuCheckboxItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("titleBarGroup")}</DropdownMenuLabel>
          {TITLE_BAR_ITEMS.map(({ id, labelKey }) => (
            <DropdownMenuCheckboxItem
              key={id}
              checked={barItems[id]}
              onCheckedChange={() => toggleBarItem(id)}
              data-testid={`title-bar-item-${id}`}
            >
              {t(labelKey)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
