"use client"

/**
 * VS Code-style layout controls for the desktop title bar: one-click toggles
 * for the Primary Side Bar, Panel, and Secondary Side Bar, plus a dropdown for
 * the full visibility set (guild rail, sidebars, panel, status bar) and
 * layout customization.
 *
 * The direct cluster deliberately mirrors VS Code's three high-value workbench
 * toggles. Lower-frequency Activity/Guild rail and Status Bar controls remain
 * in the dropdown; the native View menu (`src-tauri/src/menu.rs`) and keyboard
 * shortcuts are additional routes to the same actions.
 *
 * Subscribes to the layout stores internally so the title bar's menubar tree
 * stays render-stable (same pattern as `TitleBarSearchPill`).
 */

import * as React from "react"
import {
  LayoutDashboardIcon,
  MinusIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlusIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toggleGuildRailAction, toggleStatusBarAction } from "@/lib/desktop/menu-actions"
import {
  applyZoom,
  clampZoom,
  DEFAULT_ZOOM,
  formatZoomPercent,
  ZOOM_STEP,
} from "@/lib/tauri/webview-zoom"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { ShellLayoutDialog } from "@/components/shell/shell-layout-dialog"

const log = loggers.ui

/** Theme choices, in cycle order. Labels resolve under `desktop.titleBar.layout.theme*`. */
const THEMES = ["light", "dark", "system"] as const

export type TitleBarLayoutControl = "sidebar" | "panel" | "rightSidebar" | "customize"

const ALL_LAYOUT_CONTROLS: readonly TitleBarLayoutControl[] = [
  "sidebar",
  "panel",
  "rightSidebar",
  "customize",
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
  unread,
  onClick,
  children,
}: {
  label: string
  testId: string
  active: boolean
  /** Draw the "something arrived while this pane was dismissed" marker. */
  unread?: boolean
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
        "relative h-7 w-7 rounded-sm transition-colors hover:text-foreground",
        "motion-safe:transition-transform motion-safe:active:scale-90",
        active ? "text-foreground" : "text-muted-foreground"
      )}
    >
      {children}
      {unread ? (
        <span
          aria-hidden
          data-testid={`${testId}-unread`}
          className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
        />
      ) : null}
    </Button>
  )
}

export function TitleBarLayoutControls({
  className,
  controls = ALL_LAYOUT_CONTROLS,
}: {
  className?: string
  controls?: readonly TitleBarLayoutControl[]
}) {
  const t = useTranslations("desktop.titleBar.layout")
  const visibleControls = new Set(controls)
  const rootTestId =
    controls.length === 1 && controls[0] !== "customize"
      ? `title-bar-layout-control-${controls[0]}`
      : "title-bar-layout-controls"

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const guildRailCollapsed = useUIStore((s) => s.guildRailCollapsed)
  // While the expanded conversation sidebar hosts the navigation rows the icon
  // column is folded into it (`DesktopAppShell`), so this preference has no
  // visible effect until the sidebar collapses or the route changes. The
  // checkbox keeps reporting the *preference*; the hint says why the rail is
  // not on screen right now.
  const sidebarHostsNav = useShellColumnsStore((s) => s.sidebarHostsNav)
  const statusBarCollapsed = useUIStore((s) => s.statusBarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const [customizeOpen, setCustomizeOpen] = React.useState(false)
  const rightSidebarCollapsed = useArtifactDockLayoutStore((s) => s.dockCollapsed)
  const toggleRightSidebar = useArtifactDockLayoutStore((s) => s.toggleDock)
  // An artifact arrived while the dock was dismissed. The chat header used to
  // carry this dot on its own `ArtifactDockToggle`; that copy is gone now that
  // the bar owns the control on every route, so the signal moves here — without
  // it a background artifact would arrive silently.
  const unreadArtifact = useArtifactDockLayoutStore((s) => s.unreadArtifact)
  const openBrowser = useArtifactDockLayoutStore((s) => s.openBrowser)
  const panelOpen = useTerminalStore((s) => s.panelOpen)
  const togglePanel = useTerminalStore((s) => s.togglePanel)

  // Appearance preferences, relocated from the status bar: set once, then left
  // alone, so they belong behind a menu rather than in permanent chrome.
  const { theme, setTheme } = useTheme()
  const persistedZoom = useSettingsStore((s) => s.settings?.webviewZoom)
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const saveSettings = useSettingsStore((s) => s.save)
  const zoom = clampZoom(persistedZoom ?? DEFAULT_ZOOM)

  const sidebarOn = !sidebarCollapsed
  const rightSidebarOn = !rightSidebarCollapsed
  const showArtifactUnread = rightSidebarCollapsed && unreadArtifact
  const guildRailOn = !guildRailCollapsed
  const statusBarOn = !statusBarCollapsed

  const handleTheme = (next: string) => {
    log.info("views setTheme", { to: next })
    setTheme(next)
    // Persist too: without it `SettingsSyncProvider` re-applies the stale stored
    // theme on the next settings change and silently reverts this choice.
    void saveSettings({ theme: next as "light" | "dark" | "system" }).catch((err) =>
      log.warn("views theme persist failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    )
  }

  const handleLanguage = (next: string) => {
    log.info("views setLanguage", { to: next })
    void setLanguage(next as "en" | "zh-CN").catch((err) =>
      log.warn("views setLanguage failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    )
  }

  const handleZoom = async (kind: "in" | "out" | "reset") => {
    const target =
      kind === "reset" ? DEFAULT_ZOOM : kind === "in" ? zoom + ZOOM_STEP : zoom - ZOOM_STEP
    const next = await applyZoom(target)
    try {
      await saveSettings({ webviewZoom: next })
    } catch (err) {
      log.warn("views zoom persist failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div className={cn("flex items-center gap-0.5", className)} data-testid={rootTestId}>
      {/* Match VS Code's title-bar layout controls: one-click toggles for the
          Primary Side Bar, Panel, and Secondary Side Bar, followed by the
          Customize Layout menu. */}
      {(visibleControls.has("sidebar") ||
        visibleControls.has("panel") ||
        visibleControls.has("rightSidebar")) && (
        <div className="flex items-center gap-0.5">
          {visibleControls.has("sidebar") && (
            <LayoutToggleButton
              label={t("toggleSidebar")}
              testId="title-bar-toggle-sidebar"
              active={sidebarOn}
              onClick={toggleSidebar}
            >
              <PanelLeftIcon className="size-4" aria-hidden />
            </LayoutToggleButton>
          )}
          {visibleControls.has("panel") && (
            <LayoutToggleButton
              label={t("togglePanel")}
              testId="title-bar-toggle-panel"
              active={panelOpen}
              onClick={togglePanel}
            >
              <PanelBottomIcon className="size-4" aria-hidden />
            </LayoutToggleButton>
          )}
          {visibleControls.has("rightSidebar") && (
            <LayoutToggleButton
              label={showArtifactUnread ? t("unreadArtifacts") : t("toggleRightSidebar")}
              testId="title-bar-toggle-right-sidebar"
              active={rightSidebarOn}
              unread={showArtifactUnread}
              onClick={toggleRightSidebar}
            >
              <PanelRightIcon className="size-4" aria-hidden />
            </LayoutToggleButton>
          )}
        </div>
      )}

      {visibleControls.has("customize") && (
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
              data-testid="views-toggle-guild-rail"
            >
              {t("toggleGuildRail")}
              {sidebarHostsNav ? (
                <span
                  className="ml-auto pl-2 text-xs text-muted-foreground"
                  data-testid="views-guild-rail-folded"
                >
                  {t("guildRailFolded")}
                </span>
              ) : null}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={sidebarOn} onCheckedChange={() => toggleSidebar()}>
              {t("toggleSidebar")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={rightSidebarOn}
              onCheckedChange={() => toggleRightSidebar()}
            >
              {t("toggleRightSidebar")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={statusBarOn}
              onCheckedChange={() => toggleStatusBarAction()}
            >
              {t("toggleStatusBar")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={panelOpen} onCheckedChange={() => togglePanel()}>
              {t("togglePanel")}
            </DropdownMenuCheckboxItem>
            {/* Relocated from a dedicated globe button in the chat header. It
              reveals a panel, which is what this menu is for — and unlike the
              toggles above it is an action, so it is an item, not a checkbox. */}
            <DropdownMenuItem onSelect={() => openBrowser()} data-testid="views-open-browser">
              {t("openBrowser")}
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            {/* The eight per-segment checkboxes that used to sit here are gone.
              They could only toggle visibility, they duplicated the nav rail's
              own customizer in a different dialect, and a menu is the wrong
              place to drag things into an order. One item opens the editor that
              owns all three surfaces — rail, top bar, bottom bar. */}
            <DropdownMenuItem
              onSelect={() => setCustomizeOpen(true)}
              data-testid="views-customize-bars"
            >
              <SlidersHorizontalIcon className="size-4" aria-hidden />
              {t("customizeBars")}
            </DropdownMenuItem>

            {/* Relocated from the status bar, where theme / zoom / locale held
              three permanent slots between them. */}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("appearanceGroup")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={handleTheme}>
              {THEMES.map((value) => (
                <DropdownMenuRadioItem
                  key={value}
                  value={value}
                  data-testid={`views-theme-${value}`}
                >
                  {t(`theme${value[0].toUpperCase()}${value.slice(1)}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={language} onValueChange={handleLanguage}>
              <DropdownMenuRadioItem value="en" data-testid="views-locale-en">
                {t("localeEn")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="zh-CN" data-testid="views-locale-zh">
                {t("localeZh")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />
            {/* `onSelect` is prevented so stepping the zoom doesn't close the menu
              — adjusting it is inherently repeated. */}
            <DropdownMenuItem
              className="justify-between focus:bg-transparent"
              onSelect={(e) => e.preventDefault()}
            >
              <span>{t("zoomLabel")}</span>
              <span className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label={t("zoomOut")}
                  data-testid="views-zoom-out"
                  onClick={() => void handleZoom("out")}
                >
                  <MinusIcon className="size-3" aria-hidden />
                </Button>
                <span
                  className="w-10 text-center text-xs tabular-nums"
                  data-testid="views-zoom-value"
                >
                  {formatZoomPercent(zoom)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label={t("zoomIn")}
                  data-testid="views-zoom-in"
                  onClick={() => void handleZoom("in")}
                >
                  <PlusIcon className="size-3" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label={t("zoomReset")}
                  data-testid="views-zoom-reset"
                  onClick={() => void handleZoom("reset")}
                >
                  <RotateCcwIcon className="size-3" aria-hidden />
                </Button>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Opens on the top-bar tab because that is the surface this trigger
          lives on; the rail and bottom bar are one tab away. */}
      {visibleControls.has("customize") && (
        <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="title" />
      )}
    </div>
  )
}
