"use client"

/**
 * Views menu for the desktop title bar — the single in-window home for panel
 * visibility (guild rail, conversation sidebar, artifact dock, terminal, status
 * bar) and the optional bar segments.
 *
 * It used to be a cluster: four always-on icon buttons plus this dropdown,
 * where the buttons drove the same four toggles the dropdown listed as
 * checkboxes. One trigger replaces them; the native View menu
 * (`src-tauri/src/menu.rs`) and the ⌘ shortcuts are the other two routes to the
 * same actions.
 *
 * Subscribes to the layout stores internally so the title bar's menubar tree
 * stays render-stable (same pattern as `TitleBarSearchPill`).
 */

import * as React from "react"
import {
  LayoutDashboardIcon,
  MinusIcon,
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
import { ShellLayoutDialog } from "@/components/shell/shell-layout-dialog"

const log = loggers.ui

/** Theme choices, in cycle order. Labels resolve under `desktop.titleBar.layout.theme*`. */
const THEMES = ["light", "dark", "system"] as const

// Mirror of the title bar's popover perf override (kept local to avoid an
// import cycle with title-bar.tsx): kill the enter/exit keyframes that repaint
// large areas on Windows WebView2; keep a light shadow. No `will-change`/
// transform — it would establish a containing block that clips Radix's
// fixed-positioned submenu content under the parent's `overflow-hidden`.
const MENU_CONTENT_PERF =
  "data-[state=open]:!animate-none data-[state=closed]:!animate-none shadow-sm"

export function TitleBarLayoutControls({ className }: { className?: string }) {
  const t = useTranslations("desktop.titleBar.layout")

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const guildRailCollapsed = useUIStore((s) => s.guildRailCollapsed)
  const statusBarCollapsed = useUIStore((s) => s.statusBarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const [customizeOpen, setCustomizeOpen] = React.useState(false)
  const rightSidebarCollapsed = useArtifactDockLayoutStore((s) => s.dockCollapsed)
  const toggleRightSidebar = useArtifactDockLayoutStore((s) => s.toggleDock)
  const openBrowser = useArtifactDockLayoutStore((s) => s.openBrowser)
  const terminalOpen = useTerminalStore((s) => s.panelOpen)
  const toggleTerminal = useTerminalStore((s) => s.togglePanel)

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
    <div
      className={cn("flex items-center gap-0.5", className)}
      data-testid="title-bar-layout-controls"
    >
      {/* One trigger, not five. The four quick buttons that used to sit here
          drove exactly the four toggles the dropdown already lists as
          checkboxes — the same state rendered twice on one 32px bar. The
          dropdown is now the sole in-window entry; the native View menu and the
          ⌘ shortcuts are the other two. */}
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
          <DropdownMenuCheckboxItem checked={terminalOpen} onCheckedChange={() => toggleTerminal()}>
            {t("toggleTerminal")}
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
              <DropdownMenuRadioItem key={value} value={value} data-testid={`views-theme-${value}`}>
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

      {/* Opens on the top-bar tab because that is the surface this trigger
          lives on; the rail and bottom bar are one tab away. */}
      <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="title" />
    </div>
  )
}
