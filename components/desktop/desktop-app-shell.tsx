"use client"

/**
 * Desktop App Shell — owns the global desktop chrome (TitleBar, GuildRail,
 * StatusBar, CommandPalette, window observers) so every desktop route
 * inherits a unified frame. Mounted from `app/layout.tsx` between
 * `MobileShellWrapper` and the routed children.
 *
 *   ┌────────── TitleBar ──────────┐  ← always mounted (close button lives here)
 *   │  {children}           │ Guild │  ← page-specific content
 *   │                       │ Rail  │
 *   ├──────────── StatusBar ────────┤
 *
 * - The rail's edge is `settings.sidebarSide` (default `"right"`, as drawn).
 *   It is the outermost column on whichever side it takes, so the transient
 *   extension host bar appearing beside it never shifts it.
 *
 * - On mobile (`platform === "mobile"`) this component is a no-op so
 *   `MobileShellWrapper` keeps full ownership of the layout.
 * - On bypass routes (deep-link / overlay screens like `/share-target`,
 *   `/pair`, `/oauth`, `/canvas/join`) the chrome is suppressed so the
 *   target screen renders full-bleed.
 */

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { CommandPalette } from "@/components/desktop/command-palette"
import { GuildRail } from "@/components/shell/guild-rail"
import { StatusBar } from "@/components/desktop/status-bar"
import { TitleBar } from "@/components/desktop/title-bar"
import { FindBar } from "@/components/desktop/find-bar"
import { ShellLayoutNotice } from "@/components/desktop/shell-layout-notice"
import { WindowFocusTracker } from "@/components/desktop/window-focus-tracker"
import { WindowResizeEdges } from "@/components/desktop/window-resize-edges"
import { ZoomShortcuts } from "@/components/desktop/zoom-shortcuts"
import { VscodeExtensionHostBar } from "@/components/extensions/vscode-extension-host-bar"
import { TerminalDock } from "@/components/terminal/terminal-dock"
import { TerminalToggleShortcut } from "@/components/terminal/terminal-toggle-shortcut"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useWorkbenchActivityShortcuts } from "@/hooks/context-workbench/use-workbench-activity-shortcuts"
import { useMenuEventRouter } from "@/hooks/desktop/use-menu-event-router"
import { usePlatform } from "@/hooks/use-platform"
import { PageLoading } from "@/components/ui/loading-states"
import { loadSystemFonts } from "@/lib/appearance/load-system-fonts"
import { whenSeeded } from "@/lib/db/schema"
import { loggers } from "@cognia/logging"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"

const log = loggers.shell

const BYPASS_PREFIXES = [
  "/share-target",
  "/pair",
  "/oauth",
  "/canvas/join",
  "/pet-overlay",
  "/pet-popup",
  "/island",
  "/selection-toolbar",
]

export function isShellBypassRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return BYPASS_PREFIXES.some(
    (p) => pathname === p || pathname === `${p}.html` || pathname.startsWith(p + "/")
  )
}

export function DesktopAppShell({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()
  const pathname = usePathname()
  const router = useRouter()

  const bypass = isShellBypassRoute(pathname)
  const isMobile = platform === "mobile"

  // View menu collapse toggles. Both default to `false` (visible). Persisted
  // by the ui-store so the choice sticks across reloads.
  const guildRailCollapsed = useUIStore((s) => s.guildRailCollapsed)
  const statusBarCollapsed = useUIStore((s) => s.statusBarCollapsed)

  // Which edge the rail occupies. Selected as a scalar rather than through
  // `useSidebarLayout()` on purpose: that hook subscribes to the whole
  // `settings` object, and this component wraps every desktop route — a theme
  // or font change would re-render the entire app shell for nothing.
  const sidebarSide = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)

  // Terminal dock (plan: vscode-vivid-wilkinson) — height drives the
  // dock's slice of the shell's vertical column. Hidden when closed.
  const terminalPanelOpen = useTerminalStore((s) => s.panelOpen)
  const terminalPanelHeightPct = useTerminalStore((s) => s.panelHeightPct)
  const terminalMaximized = useTerminalStore((s) => s.maximized)
  // Slide the dock up from the bottom edge on open (and back down on close)
  // instead of popping. Only the wrapper's transform animates — the height is
  // reserved instantly so the editor above settles once and xterm fits once,
  // never per-frame. Collapses to an instant show/hide under reduced motion.
  const { reduce: motionReduce, durationScale: motionDurationScale } = useFlowMotion()

  // Bridge native-menu `menu://<id>` events into renderer actions. Must run
  // even when the in-app Menubar would render in its hamburger form so the
  // OS menu / global shortcuts still work everywhere except bypass routes
  // (where the desktop chrome is suppressed on purpose).
  useMenuEventRouter()

  // Ctrl+1..7 → the workbench's canonical activities. Mounted here, not per
  // host: the reveal resolves against whichever workbench is in front, so one
  // registration serves the chat dock, Canvas, and both editors. Registering
  // per host would put several handlers on one keystroke.
  useWorkbenchActivityShortcuts()

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
    void whenSeeded()
    // Enumerate installed fonts once so the appearance + terminal font
    // pickers can offer real system families (desktop-only, best-effort).
    void loadSystemFonts()
  }, [])

  // The `data-app-shell` body attribute switches on the global
  // `overflow:hidden` rule in globals.css. Only set it while the desktop
  // chrome is the viewport owner — bypass / mobile keep the document scroll
  // they expect.
  useEffect(() => {
    if (typeof document === "undefined") return
    if (isMobile || bypass) return
    document.body.setAttribute("data-app-shell", "true")
    return () => document.body.removeAttribute("data-app-shell")
  }, [isMobile, bypass])

  // Defense-in-depth against the SSR/hydration paint: until effects run,
  // `usePlatform()` returns the server snapshot ("web") and `usePathname()`
  // can briefly disagree with the post-hydration value. Bypass routes
  // (/share-target, /pair, /oauth, /canvas/join) must render full-bleed with
  // no chrome and no delay — Capacitor visiting /pair must never flash any
  // desktop chrome — so they keep returning children. For ordinary routes,
  // cover the boot/hydration gap with a neutral loader instead of a
  // half-painted shell (the static-export HTML shows this until JS mounts).
  if (!mounted) return bypass ? <>{children}</> : <PageLoading variant="workspace" allowReload />
  if (isMobile || bypass) return <>{children}</>

  const handleCreateTeam = () => {
    log.info("guild create-team via shell")
    router.push("/settings?section=teams")
  }
  const handleOpenSettings = (tab?: string) => {
    log.info("open settings via shell", { tab: tab ?? "general" })
    router.push(tab ? `/settings?section=${tab}` : "/settings")
  }

  // Rendered on whichever edge `sidebarSide` names — outermost either way, so
  // the rail is pinned to the window edge and never shifts when the (transient,
  // plugin-driven) extension host bar appears beside it.
  const guildRail = guildRailCollapsed ? null : (
    <GuildRail onCreateTeam={handleCreateTeam} onOpenSettings={() => handleOpenSettings()} />
  )

  return (
    <div className="relative flex h-screen w-full flex-col bg-background text-foreground">
      <WindowFocusTracker />
      <WindowResizeEdges />
      <ZoomShortcuts />
      <TerminalToggleShortcut />
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        {sidebarSide === "left" ? guildRail : null}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div data-find-scope className="flex min-h-0 flex-1 overflow-hidden">
            {children}
          </div>
          <AnimatePresence initial={false}>
            {terminalPanelOpen ? (
              <motion.div
                key="terminal-dock-region"
                data-testid="terminal-dock-region"
                className={terminalMaximized ? "absolute inset-0 z-40 min-h-0" : "min-h-0 shrink-0"}
                style={{ height: terminalMaximized ? "100%" : `${terminalPanelHeightPct}%` }}
                data-maximized={terminalMaximized ? "true" : "false"}
                initial={motionReduce ? false : { y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: motionReduce ? 0 : "100%", opacity: motionReduce ? 0 : 1 }}
                transition={{
                  duration: motionReduce ? 0 : 0.2 * motionDurationScale,
                  ease: [0.32, 0.72, 0, 1],
                }}
              >
                <TerminalDock />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        {/*
         * VS Code extension host bar — hosts webviews + terminals from
         * any activated extension. Returns `null` until an extension
         * registers a surface, so the layout is unchanged in the
         * default case. Phase A4 of the LSP reuse work.
         */}
        <VscodeExtensionHostBar className="hidden w-72 shrink-0 border-l lg:flex" />
        {sidebarSide === "right" ? guildRail : null}
      </div>
      {mounted && <CommandPalette onOpenSettings={handleOpenSettings} />}
      <FindBar />
      <ShellLayoutNotice />
      {!statusBarCollapsed && <StatusBar />}
    </div>
  )
}
