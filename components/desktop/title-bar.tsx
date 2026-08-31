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
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { useElementWidth } from "@/hooks/use-element-width"
import {
  useTitleBarOutletRef,
  useTitleBarProjectionState,
} from "@/components/shell/title-bar-outlets"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"
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
import { useUIStore } from "@/stores/ui/ui-store"
import { MaximizeIcon, MenuIcon, MinimizeIcon, MinusIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { TitleBarZone, type TitleBarItemContext } from "@/components/desktop/title-bar-zone"
import { ShellLayoutDialog } from "@/components/shell/shell-layout-dialog"
import { useBarLayout } from "@/components/shell/use-bar-layout"
import { recordNavigation } from "@/hooks/desktop/use-nav-history"
import { spawnDefaultTerminal } from "@/lib/terminal/spawn-default"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

const log = loggers.ui

const NARROW_QUERY = "(max-width: 760px)"

/**
 * Smallest share of the bar the centre zone may be squeezed to by the column
 * outlets. Half: the centre carries the route history, the workspace pill, the
 * search / palette pill and the command centre *plus* the projected chat header
 * — the outlets carry one column header each and right-align it.
 */
const TITLE_BAR_MIN_CENTRE_RATIO = 0.5

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

/**
 * VSCode-style frameless title bar (active when `decorations: false`).
 *
 * Layout per platform:
 *   • macOS:    [traffic-light room] · [centre zone] · [end zone]
 *   • Windows / Linux:
 *     [start zone + Menubar (or hamburger when narrow)] · [centre zone] ·
 *     [end zone] · [min / max / close]
 *
 * Which segments occupy those zones, and in what order, is user customization
 * persisted on `AppSettings.titleBarLayout` and resolved by
 * `useBarLayout("title")` — the same settings-backed path the nav rail and the
 * status bar use. Edit it from `/settings?section=sidebar` (Top bar tab), this
 * bar's right-click menu, or the Views menu. The segments themselves live in
 * `title-bar-zone.tsx`; the drag regions, the menubar and the window buttons
 * stay hardcoded here because they are structural.
 *
 * Right-clicking the drag region on Windows/Linux opens a small system menu;
 * double-clicking toggles maximize.
 */
export function TitleBar() {
  const t = useTranslations("desktop.titleBar")
  const tMenu = useTranslations("desktop.menu")
  const tShellLayout = useTranslations("desktop.shellLayout")
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [alwaysOnTop, setAlwaysOnTopState] = useState(false)
  const [platform, setPlatform] = useState<string>("")
  const [systemMenu, setSystemMenu] = useState<{ x: number; y: number } | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)

  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const guildRailCollapsed = useUIStore((s) => s.guildRailCollapsed)
  const statusBarCollapsed = useUIStore((s) => s.statusBarCollapsed)
  // The icon column folds into the expanded conversation sidebar while that
  // hosts the navigation rows; the View menu's checkbox keeps reporting the
  // preference and says so, instead of claiming a rail that is not drawn.
  const sidebarHostsNav = useShellColumnsStore((s) => s.sidebarHostsNav)

  // Segment order + visibility, per zone. Edited in the customizer, persisted
  // in settings; see `components/shell/use-bar-layout.ts`.
  const { resolved: bar } = useBarLayout("title")
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

  // ---- Column-header projection (see `components/shell/title-bar-outlets.tsx`)
  //
  // The chat workspace's three column headers render into this bar. The start
  // and end outlets are sized to the measured width of the conversation rail
  // and the artifact dock beneath them, less whatever chrome already occupies
  // that stretch of the bar (traffic lights, hamburger, window buttons), so the
  // centre is exactly the chat column. Measured, not derived: both columns
  // animate, and the bar has to track them frame for frame.
  //
  // What projection does NOT do any more is change the bar's own segments. The
  // search pill used to go compact and the two sidebar toggles used to drop out
  // while the chat header was up, which meant the top row was one shape inside
  // a conversation and a different one everywhere else — on the team workspace,
  // on /workflows, on the welcome screen. A shell bar that redraws itself as
  // you navigate reads as flickering, so the segments are constant now and only
  // the outlets' contents vary. The chat header drops its own duplicates of the
  // two toggles instead (`components/chat/chat-header.tsx`).
  //
  // `projected.start` still folds the Windows/Linux menubar into the hamburger:
  // that one is spatial, not cosmetic — the menus would otherwise sit over the
  // conversation rail's own column.
  const projected = useTitleBarProjectionState()
  const startOutletRef = useTitleBarOutletRef("start")
  const centerOutletRef = useTitleBarOutletRef("center")
  const endOutletRef = useTitleBarOutletRef("end")
  const measuredRailPx = useShellColumnsStore((s) => s.widths.rail)
  const sidebarPx = useShellColumnsStore((s) => s.widths.sidebar)
  const dockPx = useShellColumnsStore((s) => s.widths.dock)
  const sidebarSide = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)
  const barRef = useRef<HTMLElement | null>(null)
  const leftChromeRef = useRef<HTMLDivElement | null>(null)
  const rightChromeRef = useRef<HTMLDivElement | null>(null)
  const barPx = useElementWidth(barRef)
  const leftChromePx = useElementWidth(leftChromeRef)
  const rightChromePx = useElementWidth(rightChromeRef)
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

  // Load the most-recent sessions for the File → Recent Sessions submenu and
  // the search pill. Refreshes once on mount and whenever the active session id
  // changes (so a new conversation surfaces immediately the next time the menu
  // opens). Not Tauri-gated: the bar renders in the web shell too, where the
  // search pill's recent list is just as useful.
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  useEffect(() => {
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
    recordNavigation(pathname)
  }, [pathname])

  if (!mounted) return null

  /**
   * Whether this bar is also the *window* chrome. Inside Tauri it owns the
   * frameless window's drag region, the Windows/Linux menubar and the
   * min / max / close cluster; in the web shell it is a plain 40px application
   * bar with the same customizable zones and none of the window plumbing. It
   * used to return `null` outside Tauri, which left the web shell with three
   * stepped column headers and no bar at all; the shell-wide bar is what the
   * column headers project into (`components/shell/title-bar-outlets.tsx`).
   */
  const tauri = isTauri()
  const isMac = tauri && platform.includes("mac")
  const windowChrome = tauri && !isMac
  // Where the columns start and end relative to the bar's edges. The nav rail
  // is the outermost column on `sidebarSide`, so the conversation rail begins
  // after it on the left, and the dock ends before it on the right.
  // Measured, like the sidebar and dock: the rail hides below `md` and while
  // the expanded sidebar hosts the navigation, and reports 0 both times.
  const railPx = guildRailCollapsed ? 0 : measuredRailPx
  const railLeftPx = sidebarSide === "left" ? railPx : 0
  const railRightPx = sidebarSide === "right" ? railPx : 0
  // The conversation sidebar follows the same edge as the nav rail. On the
  // right it keeps its own header (the start zone is the *leading* column's,
  // and the bar has one of each), so it projects nothing — but it still sits
  // under the end zone, which has to span it the way it already spans the rail.
  const sidebarRightPx = sidebarSide === "right" && !projected.start ? sidebarPx : 0
  // Must match the header's `pl-22` / `pl-2` below.
  const barPaddingLeftPx = isMac ? 88 : 8
  const columnStartPx = projected.start
    ? Math.max(0, railLeftPx + sidebarPx - barPaddingLeftPx - leftChromePx)
    : 0
  const columnEndPx = projected.end
    ? Math.max(0, railRightPx + sidebarRightPx + dockPx - rightChromePx)
    : 0
  // Tracking the columns exactly is right until a column is wide enough to
  // starve the bar's own row. A workbench opened to its `wide` preset is half
  // the window, and the end outlet then reserved half the bar for a header
  // that is four right-aligned icons — the conversation title next to it
  // truncated to a single character with ~700px of empty outlet beside it.
  //
  // So the centre keeps a floor, and what it borrows comes off the projected
  // outlets: the end one first (its content is right-aligned against the bar's
  // trailing chrome, so shrinking the outlet moves nothing that is drawn — only
  // the empty leading part of it), then the start one. `barPx === 0` is "not
  // measured yet", which must not shave anything.
  const centreFloorPx = barPx > 0 ? Math.round(barPx * TITLE_BAR_MIN_CENTRE_RATIO) : 0
  const centreUnclampedPx =
    barPx > 0
      ? barPx - barPaddingLeftPx - leftChromePx - rightChromePx - columnStartPx - columnEndPx
      : 0
  const centreDeficitPx = barPx > 0 ? Math.max(0, centreFloorPx - centreUnclampedPx) : 0
  const endOutletPx = Math.max(0, columnEndPx - centreDeficitPx)
  const startOutletPx = Math.max(0, columnStartPx - Math.max(0, centreDeficitPx - columnEndPx))
  // While the centre is being *held* at that floor there is no slack to centre
  // anything in, and the counterweight below would only take the room back off
  // the projected chat header. It stands down for exactly that case — which is
  // the deficit having actually been taken off an outlet, not the raw centre
  // width. A bar with nothing projected beside it (or one narrow enough that
  // the chrome alone puts the centre under half) has no outlet to reclaim from,
  // so shaving nothing while dropping the counterweight would only shove the
  // cluster off-centre — the very thing the counterweight exists to prevent.
  const reclaimedFromOutletsPx = Math.min(centreDeficitPx, columnStartPx + columnEndPx)
  const centreHasSlack = barPx === 0 || reclaimedFromOutletsPx === 0
  // With the conversation rail's header in the bar the Windows/Linux menubar
  // would sit over that column and push its header off its own rail, so the
  // menus fold into the hamburger whenever the start zone is projected — the
  // same fold the bar already does when it is narrow.
  const menubarFolded = narrow || projected.start
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
    // Ask the palette directly instead of forging ⌘K / Ctrl+K: the keystroke
    // had to guess the platform modifier, and in the web shell `isMac` is
    // deliberately false (no window chrome), so a Mac browser sent Ctrl+K to a
    // palette listening for ⌘K and nothing opened.
    requestCommandPalette()
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
    // Open the dock AND spawn. "New terminal" that only revealed an empty panel
    // was the menu item lying about what it does; the shell / profile / cwd
    // precedence is shared with the dock's own "+" via `spawnDefaultTerminal`.
    setTerminalPanelOpen(true)
    void spawnDefaultTerminal().then((outcome) => {
      if (outcome.kind === "error")
        toast.error(t("terminalSpawnError", { message: outcome.message }))
      else if (outcome.kind === "denied") toast.error(t("terminalSpawnDenied"))
    })
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

  // Opens on every platform now. On Windows/Linux it carries the window
  // commands plus "Customize layout"; on macOS the window commands live in the
  // traffic lights, so it carries the customize entry alone — which is where a
  // user reaches for it after right-clicking the bottom bar.
  const onTitleBarContextMenu = (event: React.MouseEvent) => {
    // Ignore right-clicks on real interactive content (menu triggers, buttons,
    // the search pill). Only the bare drag region should open the system menu.
    const t = event.target as HTMLElement
    if (t.closest("button, [role='menuitem'], [data-radix-menu-content]")) return
    event.preventDefault()
    setSystemMenu({ x: event.clientX, y: event.clientY })
  }

  // Everything the customizable segments need from this component. Rebuilt per
  // render rather than memoized: the handlers below are re-created each render
  // anyway (they close over `router` / `recentSessions`), and the zones were
  // already re-rendering with the bar before they became data-driven.
  const itemCtx: TitleBarItemContext = {
    appName,
    separator: t("separator"),
    searchPlaceholder: t("searchPlaceholder"),
    kbdHint: t("kbdHint"),
    recentSessions,
    onCommandPalette: handleCommandPalette,
    onOpenRecentSession: (id) => handleOpenRecentSession(id)(),
    onGo: (id) => goAction(router, id),
  }

  return (
    <>
      <header
        ref={barRef}
        data-tauri-drag-region
        data-app-chrome
        data-testid="title-bar"
        onDoubleClick={(e) => {
          if (!windowChrome) return
          const target = e.target as HTMLElement
          if (target.closest("button, [role='menuitem'], [data-radix-menu-content]")) return
          void handleMax()
        }}
        onContextMenu={onTitleBarContextMenu}
        className={cn(
          // Tint, no border — see `guild-rail.tsx`. The tone already reads as
          // "not content"; a border on top of it is a second seam.
          // `h-10` (40px) is the shared column-header height: the conversation
          // rail, chat and workbench headers project their content into this
          // bar's zones (see `title-bar-outlets.tsx`), so the row has to be as
          // tall as the headers it replaces.
          //
          // macOS: the overlay traffic lights are native chrome this bar has to
          // make room for on BOTH axes. Vertically that is
          // `trafficLightPosition.y` in `tauri.macos.conf.json` — tao insets
          // them by growing the title-bar container and leaving the buttons at
          // their original offset inside it, so the drawn top edge lands at
          // `y - 7`, and centring a 14pt button in this 40px row wants y=20,
          // not the 10 that parked them against the window's top edge.
          // Horizontally the cluster ends around 72px, so `pl-22` (88px) is
          // what keeps the app icon off the green button instead of the 80px
          // that left them nearly touching.
          "relative flex h-[var(--chrome-h)] shrink-0 items-center bg-muted/40 text-xs select-none",
          isMac ? "pl-22" : "pl-2"
        )}
      >
        <div ref={leftChromeRef} className="flex items-center gap-1">
          <TitleBarZone items={bar.zones.start} ctx={itemCtx} />
          <PluginExtensionSlot
            point="toolbar.left"
            className="flex items-center gap-1 empty:hidden"
          />
          {windowChrome &&
            (menubarFolded ? (
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
                    {sidebarHostsNav ? (
                      <DropdownMenuShortcut>{tMenu("view.guildRailFolded")}</DropdownMenuShortcut>
                    ) : null}
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
                  <DropdownMenuItem onSelect={handleGo("go-squads")}>
                    {tMenu("go.squads")}
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
                  <DropdownMenuItem onSelect={handleGo("go-squads")}>
                    {tMenu("run.squads")}
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
                      {sidebarHostsNav ? (
                        <MenubarShortcut>{tMenu("view.guildRailFolded")}</MenubarShortcut>
                      ) : null}
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
                    <MenubarItem onSelect={handleGo("go-squads")}>
                      {tMenu("go.squads")}
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
                    <MenubarItem onSelect={handleGo("go-squads")}>
                      {tMenu("run.squads")}
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

        {/* Conversation-rail header lands here, sized to the rail below. */}
        <div
          ref={startOutletRef}
          data-testid="title-bar-outlet-start"
          // `hidden` (the attribute) while nothing projects: an empty outlet is
          // not a control, and must not read as one to the chrome budget.
          hidden={!projected.start}
          className="flex h-full min-w-0 shrink-0 items-center overflow-hidden"
          style={{ width: startOutletPx }}
        />

        <div
          data-tauri-drag-region
          className="flex flex-1 items-center justify-center gap-1 px-2 min-w-0"
        >
          {/* With the chat header projected the zone reads left to right as
              the chat column does: the header (title, chips, actions) at the
              column's leading edge, then the bar's own segments in their usual
              order — route history, workspace pill, the VS Code-style search /
              palette pill, command centre. Nothing is dropped; the header
              simply goes first. */}
          <div
            ref={centerOutletRef}
            data-testid="title-bar-outlet-center"
            hidden={!projected.center}
            className="flex h-full min-w-0 flex-1 items-center"
          />
          <TitleBarZone items={bar.zones.center} ctx={itemCtx} />
          <PluginExtensionSlot
            point="toolbar.center"
            className="ml-2 flex items-center gap-1 empty:hidden"
          />
          {/* Counterweight to the outlet. The outlet is `flex-1`, so with a
              header projected it swallows every pixel of slack and shoves the
              segments against the bar's trailing chrome — the search pill sat
              centred on every route *except* inside a conversation. Mirroring
              the outlet's flex weight on the far side keeps the cluster centred
              in the chat column either way. Rendered only while the outlet is,
              so the un-projected bar keeps the exact layout it had — and only
              while the centre is above its floor (`centreHasSlack`): an equal
              share of *no* slack is not centring, it is taking half of what is
              left off the conversation title. */}
          {projected.center && centreHasSlack ? (
            <div
              aria-hidden
              data-tauri-drag-region
              data-testid="title-bar-center-counterweight"
              className="h-full min-w-0 flex-1"
            />
          ) : null}
        </div>

        {/* Artifact-dock header lands here, sized to the dock below. */}
        <div
          ref={endOutletRef}
          data-testid="title-bar-outlet-end"
          hidden={!projected.end}
          className="flex h-full min-w-0 shrink-0 items-center overflow-hidden"
          style={{ width: endOutletPx }}
        />

        <div ref={rightChromeRef} className="flex items-center">
          <PluginExtensionSlot
            point="toolbar.right"
            className="flex items-center gap-1 px-1 empty:hidden"
          />

          <TitleBarZone items={bar.zones.end} ctx={itemCtx} />

          {windowChrome ? (
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
        </div>

        {/* Right-click menu. Anchored to the click point via a 0x0 invisible
          trigger; opening it sets the coords. The window commands are
          Win/Linux-only (macOS has the traffic lights); "Customize layout" is
          on every platform, mirroring the status bar's own context menu. */}
        {systemMenu && (
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
              {windowChrome && (
                <>
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
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                data-testid="title-bar-customize"
                onSelect={() => {
                  setSystemMenu(null)
                  setCustomizeOpen(true)
                }}
              >
                {tShellLayout("customizeTitleBar")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="title" />
    </>
  )
}

function TitleBarButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-10 w-10 rounded-none transition-colors", className)}
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
  { labelKey: "go.squads", shortcutKey: "shortcut.cmdOrCtrl6" },
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
