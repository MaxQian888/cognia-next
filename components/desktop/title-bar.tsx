"use client"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar"
import { listSessions } from "@/lib/db/sessions"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import { applyZoom, clampZoom, DEFAULT_ZOOM, ZOOM_STEP } from "@/lib/tauri/webview-zoom"
import {
  automationKillSwitchAction,
  clearCacheAction,
  goAction,
  manageConnectorsAction,
  manageMcpServerAction,
  newAgentTeamAction,
  newChatAction,
  newCharacterAction,
  newWorkflowAction,
  pluginDevtoolsAction,
  restartSidecarAction,
  setLanguageAction,
  setThemeAction,
  toggleGuildRailAction,
  toggleReduceMotionAction,
  toggleStatusBarAction,
  type MenuActionId,
} from "@/lib/desktop/menu-actions"
import { openFolderAsWorkspace } from "@/lib/workspace/open-folder"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"
import { useBarItemVisible, useUIStore } from "@/stores/ui/ui-store"
import { useActiveSessionLabel } from "@/hooks/chat/use-active-session-label"
import {
  MaximizeIcon,
  MenuIcon,
  MinimizeIcon,
  MinusIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState, useSyncExternalStore } from "react"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { TitleBarNavArrows } from "@/components/desktop/title-bar-nav-arrows"
import { TitleBarLayoutControls } from "@/components/desktop/title-bar-layout-controls"
import { TitleBarWorkspace } from "@/components/desktop/title-bar-workspace"
import { TitleBarQuickActions } from "@/components/desktop/title-bar-quick-actions"
import { AccountBarButton } from "@/components/account/account-bar-button"
import { TitleBarCommandCenterMenu } from "@/components/desktop/title-bar-command-center-menu"
import { recordNavigation } from "@/hooks/desktop/use-nav-history"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

const log = loggers.ui
const NARROW_QUERY = "(max-width: 760px)"

// Override classes applied at the call site of every MenubarContent /
// DropdownMenuContent inside the title bar. The shadcn primitives ship with
// `animate-in` / `animate-out` enter+exit keyframes plus a soft `shadow-md`,
// which on Windows WebView2 cause the popovers to repaint a large area on every
// open / cross-menu hover switch. Killing the animations and dropping the
// shadow weight removes the per-frame paint cost. tailwind-merge dedupes
// against the vendor classes so we don't have to fork components/ui/menubar.
//
// NOTE: do NOT add `will-change:transform` (or any transform/filter) here.
// Radix positions submenu content with `position: fixed` (Popper
// `strategy: "fixed"`) but does NOT portal it — the SubContent stays a DOM
// descendant of this content. A `will-change`/transform on the parent
// establishes a containing block for that fixed child, so the parent's
// `overflow-hidden` then clips the whole second-level submenu out of view.
const MENU_CONTENT_PERF =
  "data-[state=open]:!animate-none data-[state=closed]:!animate-none shadow-sm"

type WindowApi = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  isFullscreen: () => Promise<boolean>
  setFullscreen: (full: boolean) => Promise<void>
  setAlwaysOnTop?: (on: boolean) => Promise<void>
  isAlwaysOnTop?: () => Promise<boolean>
  unmaximize?: () => Promise<void>
  onResized: (cb: () => void) => Promise<() => void>
}

async function getWin(): Promise<WindowApi> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow() as unknown as WindowApi
}

function useNarrow(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
      const mq = window.matchMedia(NARROW_QUERY)
      const handler = () => notify()
      mq.addEventListener("change", handler)
      return () => mq.removeEventListener("change", handler)
    },
    () => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
      return window.matchMedia(NARROW_QUERY).matches
    },
    () => false
  )
}

// The chat-store status (changes per token during streaming) and the two
// dexie-react-hooks live queries (re-fire on any sessions / characters write)
// used to live on TitleBar itself, which forced the entire menubar tree to
// re-render whenever the active chat changed. Lifting them into a leaf
// component scoped to the search pill keeps the menubar render-stable.
function TitleBarSearchPill({
  appName,
  separator,
  placeholder,
  kbdHint,
  onClick,
}: {
  appName: string
  separator: string
  placeholder: string
  kbdHint: string
  onClick: () => void
}) {
  const status = useChatStore((s) => s.status)
  const { label: doc } = useActiveSessionLabel()
  const title = doc ? `${appName}${separator}${doc}` : appName
  const isStreaming = status === "streaming"
  return (
    <QuickSearchPill
      title={title}
      placeholder={placeholder}
      kbdHint={kbdHint}
      isStreaming={isStreaming}
      onClick={onClick}
    />
  )
}

/**
 * VSCode-style frameless title bar (active when `decorations: false`).
 *
 * Layout per platform:
 *   • macOS:    [traffic-light room] · [QuickSearchPill]
 *   • Windows / Linux:
 *     [icon + Menubar (or hamburger when narrow)] · [QuickSearchPill] · [min / max / close]
 *
 * Right-clicking the drag region on Windows/Linux opens a small system menu;
 * double-clicking toggles maximize.
 */
export function TitleBar() {
  const t = useTranslations("desktop.titleBar")
  const tMenu = useTranslations("desktop.menu")
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [alwaysOnTop, setAlwaysOnTopState] = useState(false)
  const [platform, setPlatform] = useState<string>("")
  const [systemMenu, setSystemMenu] = useState<{ x: number; y: number } | null>(null)

  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const guildRailCollapsed = useUIStore((s) => s.guildRailCollapsed)
  const statusBarCollapsed = useUIStore((s) => s.statusBarCollapsed)

  // Optional title-bar segments (toggled in the Customize Layout dropdown).
  const showWorkspace = useBarItemVisible("workspace")
  const showQuickActions = useBarItemVisible("quickActions")
  const showAccountTop = useBarItemVisible("accountTop")
  const openFind = useUIStore((s) => s.openFind)

  const persistedZoom = useSettingsStore((s) => s.settings?.webviewZoom)
  const persistedLanguage = useSettingsStore((s) => s.settings?.language)
  const persistedReduceMotion = useSettingsStore((s) => s.settings?.reduceMotion)
  const saveSettings = useSettingsStore((s) => s.save)

  // next-themes is mounted in app/layout.tsx. The hook returns `theme` (the
  // user's pick: light / dark / system) and `setTheme`. We default to
  // "system" when the provider hasn't rehydrated yet so the radio group has
  // a valid checked value on first render.
  const { theme: rawTheme, setTheme } = useTheme()
  const theme = (rawTheme ?? "system") as "light" | "dark" | "system"
  const language = persistedLanguage ?? "en"
  const reduceMotion = persistedReduceMotion ?? false

  const narrow = useNarrow()
  const pathname = usePathname()
  const terminalOpen = useTerminalStore((s) => s.panelOpen)
  const setTerminalPanelOpen = useTerminalStore((s) => s.setPanelOpen)
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel)

  const [recentSessions, setRecentSessions] = useState<
    Array<{ id: string; title: string; characterId?: string }>
  >([])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
    if (!isTauri()) return

    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const win = await getWin()
        setMaximized(await win.isMaximized())
        try {
          if (win.isAlwaysOnTop) setAlwaysOnTopState(await win.isAlwaysOnTop())
        } catch {
          /* not all platforms support isAlwaysOnTop in older Tauri builds */
        }
        if (typeof navigator !== "undefined") {
          setPlatform(navigator.platform.toLowerCase())
        }
        unlisten = await win.onResized(async () => {
          setMaximized(await win.isMaximized())
        })
      } catch (err) {
        log.warn("title-bar window setup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      unlisten?.()
    }
  }, [])

  // Load the most-recent sessions for the File → Recent Sessions submenu.
  // Refreshes once on mount and whenever the active session id changes (so a
  // new conversation surfaces immediately the next time the menu opens).
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await listSessions()
        if (!cancelled) setRecentSessions(filterExposedSessions(rows, "global-search").slice(0, 8))
      } catch (err) {
        log.warn("title-bar load recent-sessions failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId])

  // Feed the back/forward history (the title bar is mounted once for the whole
  // desktop shell, so this observes every route change).
  useEffect(() => {
    if (!isTauri()) return
    recordNavigation(pathname)
  }, [pathname])

  if (!mounted || !isTauri()) return null

  const isMac = platform.includes("mac")
  const appName = t("appName")
  const zoom = clampZoom(persistedZoom ?? DEFAULT_ZOOM)

  const handleMin = async () => {
    log.info("title-bar minimize")
    try {
      const win = await getWin()
      await win.minimize()
    } catch (err) {
      log.error("title-bar minimize failed", err)
    }
  }
  const handleMax = async () => {
    log.info("title-bar toggle maximize", { wasMaximized: maximized })
    try {
      const win = await getWin()
      await win.toggleMaximize()
    } catch (err) {
      log.error("title-bar toggle maximize failed", err)
    }
  }
  const handleClose = async () => {
    log.info("title-bar close")
    try {
      const win = await getWin()
      await win.close()
    } catch (err) {
      log.error("title-bar close failed", err)
    }
  }

  // ---- File menu actions --------------------------------------------------

  // Delegates so this File menu and the native menu bar (which fires
  // `menu://new-chat` → `newChatAction`) cannot drift apart.
  const handleNewChat = () => {
    log.info("title-bar menu new-chat")
    newChatAction()
  }
  const handleOpenWorkspace = async () => {
    log.info("title-bar menu open-workspace")
    try {
      // Unified flow: pick a folder and create/activate a real workspace Project
      // (mirrors the File menu / Cmd+O / switcher). The old `defaultWorkingDir`
      // write was shadowed by the active workspace root.
      await openFolderAsWorkspace()
    } catch (err) {
      log.warn("title-bar open-workspace failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const handleOpenSettings = () => {
    log.info("title-bar menu open-settings")
    router.push("/settings")
  }
  const handleOpenLogs = () => {
    log.info("title-bar menu open-logs")
    router.push("/logs")
  }
  const handleNewWorkflow = () => newWorkflowAction(router)
  const handleNewAgentTeam = () => newAgentTeamAction(router)
  const handleNewCharacter = () => newCharacterAction(router)
  const handleOpenRecentSession = (sessionId: string) => () => {
    log.info("title-bar menu open-recent-session", { sessionId })
    useChatStore.getState().setActiveSession(sessionId)
    setSelectedGuild({ kind: "dm" })
    router.push("/")
  }

  // ---- Edit menu (delegates to native input handling) --------------------

  const execEdit = (cmd: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") => () => {
    log.info("title-bar edit", { cmd })
    try {
      // execCommand is deprecated but it's the only way to trigger
      // selection-aware behavior for arbitrary contenteditable / input
      // targets without going through the OS clipboard explicitly.
      document.execCommand(cmd === "selectAll" ? "selectAll" : cmd)
    } catch (err) {
      log.warn("title-bar edit failed", {
        cmd,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const handleFind = () => {
    log.info("title-bar menu find")
    // Open the in-app find bar (mounted by the desktop shell). It also listens
    // for Ctrl/Cmd+F globally; this is the Edit → Find menu entry point.
    openFind()
  }

  // ---- View menu ---------------------------------------------------------

  const handleCommandPalette = () => {
    log.info("title-bar menu command-palette")
    // The command palette's global listener keys off the platform-native
    // modifier — `metaKey` (⌘) on macOS, `ctrlKey` elsewhere. The synthetic
    // dispatch must mirror that or clicking the search pill / menu item never
    // opens the palette on Mac (see command-palette.tsx).
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: !isMac, metaKey: isMac })
    )
  }
  const handleToggleSidebar = () => {
    log.info("title-bar menu toggle-sidebar")
    toggleSidebar()
  }
  const handleReload = () => {
    log.info("title-bar menu reload")
    window.location.reload()
  }
  const handleToggleFullscreen = async () => {
    log.info("title-bar menu toggle-fullscreen")
    try {
      const win = await getWin()
      const fs = await win.isFullscreen()
      await win.setFullscreen(!fs)
    } catch (err) {
      log.error("title-bar toggle-fullscreen failed", err)
    }
  }
  const handleZoom = async (kind: "in" | "out" | "reset") => {
    const target =
      kind === "reset" ? DEFAULT_ZOOM : kind === "in" ? zoom + ZOOM_STEP : zoom - ZOOM_STEP
    const next = await applyZoom(target)
    try {
      await saveSettings({ webviewZoom: next })
    } catch (err) {
      log.warn("title-bar zoom persist failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ---- View menu (extended) ----------------------------------------------

  const handleToggleGuildRail = () => toggleGuildRailAction()
  const handleToggleStatusBar = () => toggleStatusBarAction()
  const handleSetTheme = (next: "light" | "dark" | "system") => () => {
    void setThemeAction(setTheme, saveSettings, next)
  }
  const handleSetLanguage = (next: "en" | "zh-CN") => () => {
    void setLanguageAction(saveSettings, next)
  }
  const handleToggleReduceMotion = () => {
    void toggleReduceMotionAction(reduceMotion, saveSettings)
  }

  // ---- Go menu -----------------------------------------------------------

  const handleGo = (target: MenuActionId) => () => goAction(router, target)

  // ---- Terminal menu -----------------------------------------------------

  const handleNewTerminal = () => {
    log.info("title-bar terminal new")
    // Open the dock; the dock's own "+" affordance creates project-scoped tabs.
    setTerminalPanelOpen(true)
  }
  const handleToggleTerminal = () => {
    log.info("title-bar terminal toggle")
    toggleTerminalPanel()
  }

  // ---- Tools menu --------------------------------------------------------

  const handleAutomationKillSwitch = async () => {
    log.info("title-bar tools automation-kill-switch")
    try {
      await automationKillSwitchAction()
    } catch (err) {
      log.warn("title-bar tools automation-kill-switch failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const handleManageConnectors = () => manageConnectorsAction(router)
  const handleManageMcpServer = () => manageMcpServerAction(router)
  const handlePluginDevtools = () => pluginDevtoolsAction(router)
  const handleRestartSidecar = async () => {
    log.info("title-bar tools sidecar-restart")
    try {
      await restartSidecarAction()
    } catch (err) {
      log.warn("title-bar tools sidecar-restart failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const handleClearCache = async () => {
    log.info("title-bar tools clear-cache")
    try {
      await clearCacheAction()
    } catch (err) {
      log.warn("title-bar tools clear-cache failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ---- Help menu ---------------------------------------------------------

  const handleKeyboardShortcuts = () => {
    log.info("title-bar help keyboard-shortcuts")
    setShortcutsOpen(true)
  }

  // ---- Window menu -------------------------------------------------------

  const handleAlwaysOnTop = async () => {
    log.info("title-bar always-on-top toggle", { from: alwaysOnTop })
    try {
      const win = await getWin()
      if (win.setAlwaysOnTop) {
        await win.setAlwaysOnTop(!alwaysOnTop)
        setAlwaysOnTopState(!alwaysOnTop)
      }
    } catch (err) {
      log.warn("title-bar always-on-top failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleDocumentation = async () => {
    log.info("title-bar menu documentation")
    try {
      const { openExternal } = await import("@/lib/tauri/opener")
      await openExternal("https://v2.tauri.app")
    } catch (err) {
      log.error("title-bar documentation failed", err)
    }
  }
  const handleAbout = () => {
    log.info("title-bar menu about")
    router.push("/settings?section=about")
  }

  // ---- Right-click system menu (Win/Linux only) --------------------------

  const onTitleBarContextMenu = (event: React.MouseEvent) => {
    if (isMac) return
    // Ignore right-clicks on real interactive content (menu triggers, buttons,
    // the search pill). Only the bare drag region should open the system menu.
    const t = event.target as HTMLElement
    if (t.closest("button, [role='menuitem'], [data-radix-menu-content]")) return
    event.preventDefault()
    setSystemMenu({ x: event.clientX, y: event.clientY })
  }

  return (
    <>
      <header
        data-tauri-drag-region
        data-app-chrome
        data-testid="title-bar"
        onDoubleClick={(e) => {
          if (isMac) return
          const target = e.target as HTMLElement
          if (target.closest("button, [role='menuitem'], [data-radix-menu-content]")) return
          void handleMax()
        }}
        onContextMenu={onTitleBarContextMenu}
        className={cn(
          "relative flex h-8 shrink-0 items-center border-b bg-muted/40 text-xs select-none",
          isMac ? "pl-20" : "pl-2"
        )}
      >
        <div className="flex items-center gap-1">
          <SparklesIcon aria-hidden className="size-4 shrink-0 text-primary" />
          <PluginExtensionSlot
            point="toolbar.left"
            className="flex items-center gap-1 empty:hidden"
          />
          {!isMac &&
            (narrow ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t("openMenus")}
                  data-testid="title-bar-hamburger"
                  className="flex h-7 w-7 items-center justify-center rounded-sm hover:bg-accent"
                >
                  <MenuIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  sideOffset={4}
                  className={cn("w-64", MENU_CONTENT_PERF)}
                >
                  {/* File */}
                  <DropdownMenuLabel>{tMenu("file.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={handleNewChat}>
                    {tMenu("file.newChat")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlN")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleNewWorkflow}>
                    {tMenu("file.newWorkflow")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlShiftN")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleNewAgentTeam}>
                    {tMenu("file.newAgentTeam")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleNewCharacter}>
                    {tMenu("file.newCharacter")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleOpenWorkspace}>
                    {tMenu("file.openWorkspace")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlO")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleOpenSettings}>
                    {tMenu("file.openSettings")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlComma")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleOpenLogs}>
                    {tMenu("file.openLogs")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlShiftL")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{tMenu("file.recentSessions")}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className={MENU_CONTENT_PERF}>
                      {recentSessions.length === 0 ? (
                        <DropdownMenuItem disabled>
                          {tMenu("file.recentSessionsEmpty")}
                        </DropdownMenuItem>
                      ) : (
                        recentSessions.map((s) => (
                          <DropdownMenuItem key={s.id} onSelect={handleOpenRecentSession(s.id)}>
                            {s.title || tMenu("file.recentSessionsEmpty")}
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleClose}>{tMenu("file.quit")}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Edit */}
                  <DropdownMenuLabel>{tMenu("edit.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={execEdit("undo")}>
                    {tMenu("edit.undo")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={execEdit("redo")}>
                    {tMenu("edit.redo")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={execEdit("cut")}>
                    {tMenu("edit.cut")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={execEdit("copy")}>
                    {tMenu("edit.copy")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={execEdit("paste")}>
                    {tMenu("edit.paste")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={execEdit("selectAll")}>
                    {tMenu("edit.selectAll")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleFind}>
                    {tMenu("edit.find")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlF")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* View */}
                  <DropdownMenuLabel>{tMenu("view.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={handleCommandPalette}>
                    {tMenu("view.commandPalette")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlShiftP")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuCheckboxItem
                    checked={!sidebarCollapsed}
                    onCheckedChange={handleToggleSidebar}
                  >
                    {tMenu("view.toggleSidebar")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlB")}</DropdownMenuShortcut>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={!guildRailCollapsed}
                    onCheckedChange={handleToggleGuildRail}
                  >
                    {tMenu("view.toggleGuildRail")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={!statusBarCollapsed}
                    onCheckedChange={handleToggleStatusBar}
                  >
                    {tMenu("view.toggleStatusBar")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{tMenu("view.theme")}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className={MENU_CONTENT_PERF}>
                      <DropdownMenuRadioGroup value={theme}>
                        <DropdownMenuRadioItem value="light" onSelect={handleSetTheme("light")}>
                          {tMenu("view.themeLight")}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="dark" onSelect={handleSetTheme("dark")}>
                          {tMenu("view.themeDark")}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="system" onSelect={handleSetTheme("system")}>
                          {tMenu("view.themeSystem")}
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{tMenu("view.language")}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className={MENU_CONTENT_PERF}>
                      <DropdownMenuRadioGroup value={language}>
                        <DropdownMenuRadioItem value="en" onSelect={handleSetLanguage("en")}>
                          {tMenu("view.languageEnglish")}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="zh-CN" onSelect={handleSetLanguage("zh-CN")}>
                          {tMenu("view.languageChinese")}
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuCheckboxItem
                    checked={reduceMotion}
                    onCheckedChange={handleToggleReduceMotion}
                  >
                    {tMenu("view.reduceMotion")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuItem onSelect={handleReload}>
                    {tMenu("view.reload")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlR")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleOpenLogs}>
                    {tMenu("view.openLogs")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlShiftL")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleToggleFullscreen}>
                    {tMenu("view.toggleFullscreen")}
                    <DropdownMenuShortcut>{tMenu("shortcut.f11")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleZoom("in")}>
                    {tMenu("view.zoomIn")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlPlus")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleZoom("out")}>
                    {tMenu("view.zoomOut")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlMinus")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleZoom("reset")}>
                    {tMenu("view.zoomReset")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl0")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Go */}
                  <DropdownMenuLabel>{tMenu("go.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={handleGo("go-inbox")}>
                    {tMenu("go.inbox")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl1")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-workflows")}>
                    {tMenu("go.workflows")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl2")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-sites")}>
                    {tMenu("go.sites")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-twin")}>
                    {tMenu("go.twin")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl3")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-skills")}>
                    {tMenu("go.skills")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl4")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-plugins")}>
                    {tMenu("go.plugins")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl5")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-agent-teams")}>
                    {tMenu("go.agentTeams")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl6")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-scheduler")}>
                    {tMenu("go.scheduler")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl7")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-discover")}>
                    {tMenu("go.discover")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrl8")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-a2ui")}>
                    {tMenu("go.a2ui")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-dms")}>
                    {tMenu("go.dms")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-canvas")}>
                    {tMenu("go.canvas")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-logs")}>
                    {tMenu("go.logs")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-settings")}>
                    {tMenu("go.settings")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Run */}
                  <DropdownMenuLabel>{tMenu("run.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={handleNewWorkflow}>
                    {tMenu("run.newWorkflowRun")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-scheduler")}>
                    {tMenu("run.openScheduler")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleGo("go-agent-teams")}>
                    {tMenu("run.agentTeams")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void handleAutomationKillSwitch()}
                  >
                    {tMenu("run.killSwitch")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Tools */}
                  <DropdownMenuLabel>{tMenu("tools.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={handleCommandPalette}>
                    {tMenu("tools.commandPalette")}
                    <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlShiftP")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void handleAutomationKillSwitch()}
                  >
                    {tMenu("tools.automationKillSwitch")}
                    <DropdownMenuShortcut>{tMenu("shortcut.ctrlAltK")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleManageConnectors}>
                    {tMenu("tools.manageConnectors")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleManageMcpServer}>
                    {tMenu("tools.manageMcpServer")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handlePluginDevtools}>
                    {tMenu("tools.pluginDevtools")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleRestartSidecar()}>
                    {tMenu("tools.sidecarRestart")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleClearCache()}>
                    {tMenu("tools.clearCache")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Terminal */}
                  <DropdownMenuLabel>{tMenu("terminal.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={handleNewTerminal}>
                    {tMenu("terminal.new")}
                  </DropdownMenuItem>
                  <DropdownMenuCheckboxItem
                    checked={terminalOpen}
                    onCheckedChange={handleToggleTerminal}
                  >
                    {tMenu("terminal.togglePanel")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuItem onSelect={() => void handleRestartSidecar()}>
                    {tMenu("terminal.restartSidecar")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Window */}
                  <DropdownMenuLabel>{tMenu("window.label")}</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={alwaysOnTop}
                    onCheckedChange={() => void handleAlwaysOnTop()}
                  >
                    {tMenu("window.alwaysOnTop")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuItem onSelect={() => void handleMin()}>
                    {tMenu("window.minimize")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleMax()}>
                    {maximized ? tMenu("window.restore") : tMenu("window.maximize")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleClose()}>
                    {tMenu("window.close")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Help */}
                  <DropdownMenuLabel>{tMenu("help.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={handleKeyboardShortcuts}>
                    {tMenu("help.keyboardShortcuts")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleDocumentation()}>
                    {tMenu("help.documentation")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleAbout}>{tMenu("help.about")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Menubar className="h-7 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none">
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("file.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarItem onSelect={handleNewChat}>
                      {tMenu("file.newChat")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlN")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleNewWorkflow}>
                      {tMenu("file.newWorkflow")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlShiftN")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleNewAgentTeam}>
                      {tMenu("file.newAgentTeam")}
                    </MenubarItem>
                    <MenubarItem onSelect={handleNewCharacter}>
                      {tMenu("file.newCharacter")}
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={handleOpenWorkspace}>
                      {tMenu("file.openWorkspace")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlO")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleOpenSettings}>
                      {tMenu("file.openSettings")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlComma")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleOpenLogs}>
                      {tMenu("file.openLogs")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlShiftL")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarSub>
                      <MenubarSubTrigger>{tMenu("file.recentSessions")}</MenubarSubTrigger>
                      <MenubarSubContent className={MENU_CONTENT_PERF}>
                        {recentSessions.length === 0 ? (
                          <MenubarItem disabled>{tMenu("file.recentSessionsEmpty")}</MenubarItem>
                        ) : (
                          recentSessions.map((s) => (
                            <MenubarItem key={s.id} onSelect={handleOpenRecentSession(s.id)}>
                              {s.title || tMenu("file.recentSessionsEmpty")}
                            </MenubarItem>
                          ))
                        )}
                      </MenubarSubContent>
                    </MenubarSub>
                    <MenubarSeparator />
                    <MenubarItem onSelect={handleClose}>{tMenu("file.quit")}</MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("edit.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarItem onSelect={execEdit("undo")}>{tMenu("edit.undo")}</MenubarItem>
                    <MenubarItem onSelect={execEdit("redo")}>{tMenu("edit.redo")}</MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={execEdit("cut")}>{tMenu("edit.cut")}</MenubarItem>
                    <MenubarItem onSelect={execEdit("copy")}>{tMenu("edit.copy")}</MenubarItem>
                    <MenubarItem onSelect={execEdit("paste")}>{tMenu("edit.paste")}</MenubarItem>
                    <MenubarItem onSelect={execEdit("selectAll")}>
                      {tMenu("edit.selectAll")}
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={handleFind}>
                      {tMenu("edit.find")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlF")}</MenubarShortcut>
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("view.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarItem onSelect={handleCommandPalette}>
                      {tMenu("view.commandPalette")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlShiftP")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarCheckboxItem
                      checked={!sidebarCollapsed}
                      onCheckedChange={handleToggleSidebar}
                    >
                      {tMenu("view.toggleSidebar")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlB")}</MenubarShortcut>
                    </MenubarCheckboxItem>
                    <MenubarCheckboxItem
                      checked={!guildRailCollapsed}
                      onCheckedChange={handleToggleGuildRail}
                    >
                      {tMenu("view.toggleGuildRail")}
                    </MenubarCheckboxItem>
                    <MenubarCheckboxItem
                      checked={!statusBarCollapsed}
                      onCheckedChange={handleToggleStatusBar}
                    >
                      {tMenu("view.toggleStatusBar")}
                    </MenubarCheckboxItem>
                    <MenubarSeparator />
                    <MenubarSub>
                      <MenubarSubTrigger>{tMenu("view.theme")}</MenubarSubTrigger>
                      <MenubarSubContent className={MENU_CONTENT_PERF}>
                        <MenubarRadioGroup value={theme}>
                          <MenubarRadioItem value="light" onSelect={handleSetTheme("light")}>
                            {tMenu("view.themeLight")}
                          </MenubarRadioItem>
                          <MenubarRadioItem value="dark" onSelect={handleSetTheme("dark")}>
                            {tMenu("view.themeDark")}
                          </MenubarRadioItem>
                          <MenubarRadioItem value="system" onSelect={handleSetTheme("system")}>
                            {tMenu("view.themeSystem")}
                          </MenubarRadioItem>
                        </MenubarRadioGroup>
                      </MenubarSubContent>
                    </MenubarSub>
                    <MenubarSub>
                      <MenubarSubTrigger>{tMenu("view.language")}</MenubarSubTrigger>
                      <MenubarSubContent className={MENU_CONTENT_PERF}>
                        <MenubarRadioGroup value={language}>
                          <MenubarRadioItem value="en" onSelect={handleSetLanguage("en")}>
                            {tMenu("view.languageEnglish")}
                          </MenubarRadioItem>
                          <MenubarRadioItem value="zh-CN" onSelect={handleSetLanguage("zh-CN")}>
                            {tMenu("view.languageChinese")}
                          </MenubarRadioItem>
                        </MenubarRadioGroup>
                      </MenubarSubContent>
                    </MenubarSub>
                    <MenubarCheckboxItem
                      checked={reduceMotion}
                      onCheckedChange={handleToggleReduceMotion}
                    >
                      {tMenu("view.reduceMotion")}
                    </MenubarCheckboxItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={handleReload}>
                      {tMenu("view.reload")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlR")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleOpenLogs}>
                      {tMenu("view.openLogs")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlShiftL")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleToggleFullscreen}>
                      {tMenu("view.toggleFullscreen")}
                      <MenubarShortcut>{tMenu("shortcut.f11")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={() => void handleZoom("in")}>
                      {tMenu("view.zoomIn")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlPlus")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={() => void handleZoom("out")}>
                      {tMenu("view.zoomOut")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlMinus")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={() => void handleZoom("reset")}>
                      {tMenu("view.zoomReset")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl0")}</MenubarShortcut>
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("go.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarItem onSelect={handleGo("go-inbox")}>
                      {tMenu("go.inbox")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl1")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-workflows")}>
                      {tMenu("go.workflows")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl2")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-sites")}>{tMenu("go.sites")}</MenubarItem>
                    <MenubarItem onSelect={handleGo("go-twin")}>
                      {tMenu("go.twin")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl3")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-skills")}>
                      {tMenu("go.skills")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl4")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-plugins")}>
                      {tMenu("go.plugins")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl5")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-agent-teams")}>
                      {tMenu("go.agentTeams")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl6")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-scheduler")}>
                      {tMenu("go.scheduler")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl7")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-discover")}>
                      {tMenu("go.discover")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrl8")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={handleGo("go-a2ui")}>{tMenu("go.a2ui")}</MenubarItem>
                    <MenubarItem onSelect={handleGo("go-dms")}>{tMenu("go.dms")}</MenubarItem>
                    <MenubarItem onSelect={handleGo("go-canvas")}>{tMenu("go.canvas")}</MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={handleGo("go-logs")}>{tMenu("go.logs")}</MenubarItem>
                    <MenubarItem onSelect={handleGo("go-settings")}>
                      {tMenu("go.settings")}
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("run.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarItem onSelect={handleNewWorkflow}>
                      {tMenu("run.newWorkflowRun")}
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-scheduler")}>
                      {tMenu("run.openScheduler")}
                    </MenubarItem>
                    <MenubarItem onSelect={handleGo("go-agent-teams")}>
                      {tMenu("run.agentTeams")}
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem
                      onSelect={() => void handleAutomationKillSwitch()}
                      variant="destructive"
                    >
                      {tMenu("run.killSwitch")}
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("tools.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarItem onSelect={handleCommandPalette}>
                      {tMenu("tools.commandPalette")}
                      <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlShiftP")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem
                      onSelect={() => void handleAutomationKillSwitch()}
                      variant="destructive"
                    >
                      {tMenu("tools.automationKillSwitch")}
                      <MenubarShortcut>{tMenu("shortcut.ctrlAltK")}</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={handleManageConnectors}>
                      {tMenu("tools.manageConnectors")}
                    </MenubarItem>
                    <MenubarItem onSelect={handleManageMcpServer}>
                      {tMenu("tools.manageMcpServer")}
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={handlePluginDevtools}>
                      {tMenu("tools.pluginDevtools")}
                    </MenubarItem>
                    <MenubarItem onSelect={() => void handleRestartSidecar()}>
                      {tMenu("tools.sidecarRestart")}
                    </MenubarItem>
                    <MenubarItem onSelect={() => void handleClearCache()}>
                      {tMenu("tools.clearCache")}
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("terminal.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarItem onSelect={handleNewTerminal}>{tMenu("terminal.new")}</MenubarItem>
                    <MenubarCheckboxItem
                      checked={terminalOpen}
                      onCheckedChange={handleToggleTerminal}
                    >
                      {tMenu("terminal.togglePanel")}
                    </MenubarCheckboxItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={() => void handleRestartSidecar()}>
                      {tMenu("terminal.restartSidecar")}
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("window.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarCheckboxItem
                      checked={alwaysOnTop}
                      onCheckedChange={() => void handleAlwaysOnTop()}
                    >
                      {tMenu("window.alwaysOnTop")}
                    </MenubarCheckboxItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={() => void handleMin()}>
                      {tMenu("window.minimize")}
                    </MenubarItem>
                    <MenubarItem onSelect={() => void handleMax()}>
                      {maximized ? tMenu("window.restore") : tMenu("window.maximize")}
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={() => void handleClose()}>
                      {tMenu("window.close")}
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="px-2 py-0.5 text-xs">
                    {tMenu("help.label")}
                  </MenubarTrigger>
                  <MenubarContent className={MENU_CONTENT_PERF}>
                    <MenubarItem onSelect={handleKeyboardShortcuts}>
                      {tMenu("help.keyboardShortcuts")}
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={() => void handleDocumentation()}>
                      {tMenu("help.documentation")}
                    </MenubarItem>
                    <MenubarItem onSelect={handleAbout}>{tMenu("help.about")}</MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
              </Menubar>
            ))}
        </div>

        <div
          data-tauri-drag-region
          className="flex flex-1 items-center justify-center gap-1 px-2 min-w-0"
        >
          <TitleBarNavArrows className="shrink-0" />
          {showWorkspace && <TitleBarWorkspace className="hidden shrink-0 lg:flex" />}
          <div className="flex min-w-0 max-w-[480px] flex-1 items-center justify-center">
            <TitleBarSearchPill
              appName={appName}
              separator={t("separator")}
              placeholder={t("searchPlaceholder")}
              kbdHint={t("kbdHint")}
              onClick={handleCommandPalette}
            />
            <TitleBarCommandCenterMenu
              className="hidden lg:inline-flex"
              recentSessions={recentSessions}
              onCommandPalette={handleCommandPalette}
              onOpenRecentSession={(id) => handleOpenRecentSession(id)()}
              onGo={(id) => goAction(router, id)}
            />
          </div>
          <PluginExtensionSlot
            point="toolbar.center"
            className="ml-2 flex items-center gap-1 empty:hidden"
          />
        </div>

        <PluginExtensionSlot
          point="toolbar.right"
          className="flex items-center gap-1 px-1 empty:hidden"
        />

        {showQuickActions && <TitleBarQuickActions className="hidden xl:flex" />}

        {showAccountTop && <AccountBarButton className="mx-0.5" />}

        <TitleBarLayoutControls className="px-1" />

        {!isMac ? (
          <div className="flex items-center">
            <TitleBarButton onClick={handleMin} aria-label={t("minimize")}>
              <MinusIcon className="size-3.5" />
            </TitleBarButton>
            <TitleBarButton
              onClick={handleMax}
              aria-label={maximized ? t("restore") : t("maximize")}
            >
              {maximized ? (
                <MinimizeIcon className="size-3.5" />
              ) : (
                <MaximizeIcon className="size-3.5" />
              )}
            </TitleBarButton>
            <TitleBarButton
              onClick={handleClose}
              aria-label={t("close")}
              className="hover:bg-destructive hover:text-destructive-foreground"
            >
              <XIcon className="size-3.5" />
            </TitleBarButton>
          </div>
        ) : (
          <div data-tauri-drag-region className="w-2" />
        )}

        {/* Right-click system menu (Win/Linux). Anchored to the click point via
          a 0x0 invisible trigger; opening it sets the coords. */}
        {systemMenu && !isMac && (
          <DropdownMenu open onOpenChange={(open) => !open && setSystemMenu(null)}>
            <DropdownMenuTrigger
              data-testid="title-bar-system-menu-trigger"
              style={{
                position: "fixed",
                left: systemMenu.x,
                top: systemMenu.y,
                width: 0,
                height: 0,
                pointerEvents: "none",
              }}
              aria-hidden
            />
            <DropdownMenuContent align="start" sideOffset={0} className={MENU_CONTENT_PERF}>
              <DropdownMenuItem
                disabled={!maximized}
                onSelect={async () => {
                  setSystemMenu(null)
                  if (maximized) await handleMax()
                }}
              >
                {tMenu("window.restore")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={async () => {
                  setSystemMenu(null)
                  await handleMin()
                }}
              >
                {tMenu("window.minimize")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={async () => {
                  setSystemMenu(null)
                  if (!maximized) await handleMax()
                }}
                disabled={maximized}
              >
                {tMenu("window.maximize")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  setSystemMenu(null)
                  await handleClose()
                }}
              >
                {tMenu("window.close")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  )
}

function QuickSearchPill({
  title,
  placeholder,
  kbdHint,
  isStreaming,
  onClick,
}: {
  title: string
  placeholder: string
  kbdHint: string
  isStreaming: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="title-bar-search-pill"
      aria-label={placeholder}
      className={cn(
        "group flex h-6 min-w-[180px] max-w-[480px] flex-1 items-center gap-2",
        "rounded-md border border-border bg-background/60 px-2 text-xs",
        "text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      )}
    >
      {isStreaming ? (
        <span
          aria-hidden
          data-testid="title-bar-streaming-dot"
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
        />
      ) : (
        <SearchIcon aria-hidden className="size-3 shrink-0" />
      )}
      <span className="truncate font-medium tracking-tight" data-testid="title-bar-title">
        {title}
      </span>
      <span aria-hidden className="ml-auto hidden text-[10px] opacity-60 sm:inline">
        {kbdHint}
      </span>
    </button>
  )
}

function TitleBarButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-8 w-10 rounded-none transition-colors", className)}
      {...props}
    />
  )
}

/**
 * Reference table of every keyboard shortcut surfaced by the desktop chrome.
 * Each row maps a localized label to the shortcut chord — labels and chords
 * both come from the i18n bundle so translators control the strings.
 */
const SHORTCUT_ROWS: Array<{ labelKey: string; shortcutKey: string }> = [
  { labelKey: "file.newChat", shortcutKey: "shortcut.cmdOrCtrlN" },
  { labelKey: "file.newWorkflow", shortcutKey: "shortcut.cmdOrCtrlShiftN" },
  { labelKey: "file.openWorkspace", shortcutKey: "shortcut.cmdOrCtrlO" },
  { labelKey: "file.openSettings", shortcutKey: "shortcut.cmdOrCtrlComma" },
  { labelKey: "file.openLogs", shortcutKey: "shortcut.cmdOrCtrlShiftL" },
  { labelKey: "edit.find", shortcutKey: "shortcut.cmdOrCtrlF" },
  { labelKey: "view.commandPalette", shortcutKey: "shortcut.cmdOrCtrlShiftP" },
  { labelKey: "view.toggleSidebar", shortcutKey: "shortcut.cmdOrCtrlB" },
  { labelKey: "view.reload", shortcutKey: "shortcut.cmdOrCtrlR" },
  { labelKey: "view.toggleDevtools", shortcutKey: "shortcut.cmdOrCtrlAltI" },
  { labelKey: "view.toggleFullscreen", shortcutKey: "shortcut.f11" },
  { labelKey: "view.zoomIn", shortcutKey: "shortcut.cmdOrCtrlPlus" },
  { labelKey: "view.zoomOut", shortcutKey: "shortcut.cmdOrCtrlMinus" },
  { labelKey: "view.zoomReset", shortcutKey: "shortcut.cmdOrCtrl0" },
  { labelKey: "go.inbox", shortcutKey: "shortcut.cmdOrCtrl1" },
  { labelKey: "go.workflows", shortcutKey: "shortcut.cmdOrCtrl2" },
  { labelKey: "go.twin", shortcutKey: "shortcut.cmdOrCtrl3" },
  { labelKey: "go.skills", shortcutKey: "shortcut.cmdOrCtrl4" },
  { labelKey: "go.plugins", shortcutKey: "shortcut.cmdOrCtrl5" },
  { labelKey: "go.agentTeams", shortcutKey: "shortcut.cmdOrCtrl6" },
  { labelKey: "go.scheduler", shortcutKey: "shortcut.cmdOrCtrl7" },
  { labelKey: "go.discover", shortcutKey: "shortcut.cmdOrCtrl8" },
  { labelKey: "tools.automationKillSwitch", shortcutKey: "shortcut.ctrlAltK" },
]

function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const tMenu = useTranslations("desktop.menu")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="keyboard-shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{tMenu("help.keyboardShortcutsTitle")}</DialogTitle>
          <DialogDescription>{tMenu("help.keyboardShortcutsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <ul className="divide-y text-sm">
            {SHORTCUT_ROWS.map((row) => (
              <li key={row.labelKey} className="flex items-center justify-between gap-4 py-1.5">
                <span className="text-foreground">{tMenu(row.labelKey)}</span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {tMenu(row.shortcutKey)}
                </kbd>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{tMenu("help.keyboardShortcutsClose")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
