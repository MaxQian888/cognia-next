"use client"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar"
import { getCharacter } from "@/lib/db/characters"
import { getSession } from "@/lib/db/sessions"
import { loggers } from "@/lib/logger"
import { isTauri } from "@/lib/tauri"
import { applyZoom, clampZoom, DEFAULT_ZOOM, ZOOM_STEP } from "@/lib/tauri/webview-zoom"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui/ui-store"
import { useLiveQuery } from "dexie-react-hooks"
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
import { useRouter } from "next/navigation"
import { useEffect, useState, useSyncExternalStore } from "react"

const log = loggers.ui
const NARROW_QUERY = "(max-width: 760px)"

// Override classes applied at the call site of every MenubarContent /
// DropdownMenuContent inside the title bar. The shadcn primitives ship with
// `animate-in` / `animate-out` enter+exit keyframes plus a soft `shadow-md`,
// which on Windows WebView2 cause the popovers to repaint a large area on every
// open / cross-menu hover switch. Killing the animations and dropping the
// shadow weight removes the per-frame paint cost; `will-change` hints the
// compositor to promote the popover to its own layer. tailwind-merge dedupes
// against the vendor classes so we don't have to fork components/ui/menubar.
const MENU_CONTENT_PERF =
  "data-[state=open]:!animate-none data-[state=closed]:!animate-none shadow-sm [will-change:transform,opacity]"

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
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const status = useChatStore((s) => s.status)
  const session = useLiveQuery(
    () => (activeSessionId ? getSession(activeSessionId) : Promise.resolve(undefined)),
    [activeSessionId]
  )
  const character = useLiveQuery(
    () => (session?.characterId ? getCharacter(session.characterId) : Promise.resolve(undefined)),
    [session?.characterId]
  )
  const doc = character?.name ?? session?.title ?? null
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

  const persistedZoom = useSettingsStore((s) => s.settings?.webviewZoom)
  const saveSettings = useSettingsStore((s) => s.save)

  const narrow = useNarrow()

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

  const handleNewChat = () => {
    log.info("title-bar menu new-chat")
    useChatStore.getState().clear()
    setSelectedGuild({ kind: "dm" })
  }
  const handleOpenWorkspace = async () => {
    log.info("title-bar menu open-workspace")
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog")
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Select workspace",
      })
      if (typeof picked === "string") {
        await useSettingsStore.getState().save({ defaultWorkingDir: picked })
      }
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
    // Browser-native find. Webviews honor this; ChatPane / Canvas can intercept
    // the chord later if they need an in-app finder.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }))
  }

  // ---- View menu ---------------------------------------------------------

  const handleCommandPalette = () => {
    log.info("title-bar menu command-palette")
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))
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

  // ---- Go menu -----------------------------------------------------------

  const handleGo = (target: "dms" | "canvas" | "twin" | "logs" | "settings") => () => {
    log.info("title-bar go", { target })
    if (target === "dms") {
      setSelectedGuild({ kind: "dm" })
      router.push("/")
    } else if (target === "canvas") {
      setSelectedGuild({ kind: "canvas" })
      router.push("/")
    } else if (target === "twin") {
      router.push("/twin")
    } else if (target === "logs") {
      router.push("/logs")
    } else if (target === "settings") {
      router.push("/settings")
    }
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
                className={cn("w-60", MENU_CONTENT_PERF)}
              >
                {/* File */}
                <DropdownMenuLabel>{tMenu("file.label")}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={handleNewChat}>
                  {tMenu("file.newChat")}
                  <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlN")}</DropdownMenuShortcut>
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
                <DropdownMenuItem onSelect={execEdit("cut")}>{tMenu("edit.cut")}</DropdownMenuItem>
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
                <DropdownMenuItem onSelect={handleToggleSidebar}>
                  {tMenu("view.toggleSidebar")}
                  <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlB")}</DropdownMenuShortcut>
                </DropdownMenuItem>
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
                <DropdownMenuItem onSelect={handleGo("dms")}>{tMenu("go.dms")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleGo("canvas")}>
                  {tMenu("go.canvas")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleGo("twin")}>{tMenu("go.twin")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleGo("logs")}>{tMenu("go.logs")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleGo("settings")}>
                  {tMenu("go.settings")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* Window */}
                <DropdownMenuLabel>{tMenu("window.label")}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void handleAlwaysOnTop()}>
                  {tMenu("window.alwaysOnTop")}
                  {alwaysOnTop && <DropdownMenuShortcut>✓</DropdownMenuShortcut>}
                </DropdownMenuItem>
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
                  <MenubarItem onSelect={handleToggleSidebar}>
                    {tMenu("view.toggleSidebar")}
                    <MenubarShortcut>{tMenu("shortcut.cmdOrCtrlB")}</MenubarShortcut>
                  </MenubarItem>
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
                <MenubarTrigger className="px-2 py-0.5 text-xs">{tMenu("go.label")}</MenubarTrigger>
                <MenubarContent className={MENU_CONTENT_PERF}>
                  <MenubarItem onSelect={handleGo("dms")}>{tMenu("go.dms")}</MenubarItem>
                  <MenubarItem onSelect={handleGo("canvas")}>{tMenu("go.canvas")}</MenubarItem>
                  <MenubarItem onSelect={handleGo("twin")}>{tMenu("go.twin")}</MenubarItem>
                  <MenubarSeparator />
                  <MenubarItem onSelect={handleGo("logs")}>{tMenu("go.logs")}</MenubarItem>
                  <MenubarItem onSelect={handleGo("settings")}>{tMenu("go.settings")}</MenubarItem>
                </MenubarContent>
              </MenubarMenu>
              <MenubarMenu>
                <MenubarTrigger className="px-2 py-0.5 text-xs">
                  {tMenu("window.label")}
                </MenubarTrigger>
                <MenubarContent className={MENU_CONTENT_PERF}>
                  <MenubarItem onSelect={() => void handleAlwaysOnTop()}>
                    {tMenu("window.alwaysOnTop")}
                    {alwaysOnTop && <MenubarShortcut>✓</MenubarShortcut>}
                  </MenubarItem>
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
                  <MenubarItem onSelect={() => void handleDocumentation()}>
                    {tMenu("help.documentation")}
                  </MenubarItem>
                  <MenubarItem onSelect={handleAbout}>{tMenu("help.about")}</MenubarItem>
                </MenubarContent>
              </MenubarMenu>
            </Menubar>
          ))}
      </div>

      <div data-tauri-drag-region className="flex flex-1 items-center justify-center px-2 min-w-0">
        <TitleBarSearchPill
          appName={appName}
          separator={t("separator")}
          placeholder={t("searchPlaceholder")}
          kbdHint={t("kbdHint")}
          onClick={handleCommandPalette}
        />
      </div>

      {!isMac ? (
        <div className="flex items-center">
          <TitleBarButton onClick={handleMin} aria-label={t("minimize")}>
            <MinusIcon className="size-3.5" />
          </TitleBarButton>
          <TitleBarButton onClick={handleMax} aria-label={maximized ? t("restore") : t("maximize")}>
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
      className={cn("h-8 w-10 rounded-none", className)}
      {...props}
    />
  )
}
