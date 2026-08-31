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
 * - Whenever the compact shell owns the layout (`lib/shell/compact-shell.ts`:
 *   a native mobile runtime at any width, or a narrow non-Tauri viewport)
 *   this component is a no-op so `MobileShellWrapper` keeps full ownership.
 *   Tauri is deliberately excluded from the narrow branch: its window is
 *   `decorations: false`, so the `TitleBar` below carries the window
 *   controls and handing the frame away would take them with it.
 * - On bypass routes (deep-link / overlay screens like `/share-target`,
 *   `/pair`, `/oauth`, `/canvas/join`) the chrome is suppressed so the
 *   target screen renders full-bleed. `/onboarding` joins them for its own
 *   reason (ADR-0122): the first-run flow owns the window and draws its own
 *   window bar, so painting a workspace frame around it would be advertising
 *   an app the user has not finished setting up.
 */

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { CommandPalette } from "@/components/desktop/command-palette"
import { GuildRail } from "@/components/shell/guild-rail"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { TitleBarOutletsProvider } from "@/components/shell/title-bar-outlets"
import { StatusBar } from "@/components/desktop/status-bar"
import { TitleBar } from "@/components/desktop/title-bar"
import { FindBar } from "@/components/desktop/find-bar"
import { FileViewerDialog } from "@/components/file-viewer/file-viewer-dialog"
import { WorkspaceDialogHost } from "@/components/workspace/workspace-dialog-host"
import { ShellLayoutNotice } from "@/components/desktop/shell-layout-notice"
import { WindowFocusTracker } from "@/components/desktop/window-focus-tracker"
import { WindowResizeEdges } from "@/components/desktop/window-resize-edges"
import { ZoomShortcuts } from "@/components/desktop/zoom-shortcuts"
import { VscodeExtensionHostBar } from "@/components/extensions/vscode-extension-host-bar"
import { TerminalDockMoveProvider } from "@/components/terminal/terminal-dock-move-provider"
import { TerminalDockRegion } from "@/components/terminal/terminal-dock-region"
import { TerminalToggleShortcut } from "@/components/terminal/terminal-toggle-shortcut"
import { useWorkbenchActivityShortcuts } from "@/hooks/context-workbench/use-workbench-activity-shortcuts"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { toggleSidebarAction } from "@/lib/desktop/menu-actions"
import { PanelQuickSwitch } from "@/components/context-workbench/panel-quick-switch"
import { useMenuEventRouter } from "@/hooks/desktop/use-menu-event-router"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { usePlatform } from "@/hooks/use-platform"
import { PageLoading } from "@/components/ui/loading-states"
import { loadSystemFonts } from "@/lib/appearance/load-system-fonts"
import { whenSeeded } from "@/lib/db/schema"
import { loggers } from "@cognia/logging"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"
import { AgentExecutionHandleProvider } from "@/components/providers/agent-execution-handle-provider"
import { FinishSetupBar } from "@/components/onboarding/finish-setup-bar"
import { isShellBypassRoute } from "@/lib/shell/bypass-routes"
import { usesCompactShell } from "@/lib/shell/compact-shell"
import { isOnboardingRoute } from "@/lib/onboarding/route"

const log = loggers.shell

// Re-exported so the shell stays the discoverable home of "which routes have
// no chrome"; the list itself lives in `lib/shell/bypass-routes` because
// `FinishSetupBar` — chrome this shell mounts — has to read it too.
export { isShellBypassRoute }

export function DesktopAppShell({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()
  const pathname = usePathname()
  const router = useRouter()

  // Two reasons to render no chrome, deliberately kept apart. `bypass` is the
  // deep-link / overlay list; the first-run takeover (ADR-0122) is a route the
  // user is *sent* to, which owns the window for the length of setup and draws
  // its own window bar. Both suppress the same chrome, so they collapse into
  // one flag here — but they answer to different owners, and merging the lists
  // would have put "the flow the gate redirects into" in a file whose contract
  // is "screens that keep the document scroll".
  const bypass = isShellBypassRoute(pathname) || isOnboardingRoute(pathname)
  // The question is not "is this a phone" but "is the phone-shaped shell
  // drawing the frame". The same helper answers it in `MobileShellWrapper`,
  // so the two cannot drift into both owning or neither owning the layout.
  const compactShell = usesCompactShell(platform, useCompactLayout())

  // View menu collapse toggles. Both default to `false` (visible). Persisted
  // by the ui-store so the choice sticks across reloads.
  const guildRailCollapsed = useUIStore((s) => s.guildRailCollapsed)
  // The expanded workspace sidebar hosts the shell navigation as rows
  // (`components/shell/sidebar-nav-section.tsx`); while it does, the 56px
  // icon column is its collapsed twin and stays off screen.
  const sidebarHostsNav = useShellColumnsStore((s) => s.sidebarHostsNav)
  const statusBarCollapsed = useUIStore((s) => s.statusBarCollapsed)

  // Which edge the rail occupies. Selected as a scalar rather than through
  // `useSidebarLayout()` on purpose: that hook subscribes to the whole
  // `settings` object, and this component wraps every desktop route — a theme
  // or font change would re-render the entire app shell for nothing.
  const sidebarSide = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)

  // Terminal dock. Both slots stay mounted permanently, each collapsed to a
  // zero-size box unless it owns the store's current `panelPosition` — which is
  // what lets the dock be handed between the bottom edge and the right column,
  // and what lets either edge animate its own opening at all. All of its state
  // lives in `TerminalDockRegion` rather than here — this shell wraps every
  // desktop route, so a selector added at this level re-renders the whole app on
  // every dock resize.

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

  // ⌘B / Ctrl+B → conversation sidebar. Under Tauri this is a native menu
  // accelerator (`menu.rs` → `useMenuEventRouter` → the same action), which
  // the catalog's `when` clause keeps in charge there; this DOM binding is
  // what makes the chord the View menu and the shortcuts dialog advertise
  // real in the web shell too. Fires while the composer has focus, like VS
  // Code's, so a writer can hide the list without leaving the editor.
  useAppShortcut("shell.sidebar.toggle", toggleSidebarAction, {
    enabled: !compactShell && !bypass,
    allowInEditable: true,
    preventDefault: true,
  })

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
  // chrome is the viewport owner. Bypass routes and the compact shell keep
  // the document scroll they expect.
  useEffect(() => {
    if (typeof document === "undefined") return
    if (compactShell || bypass) return
    document.body.setAttribute("data-app-shell", "true")
    return () => document.body.removeAttribute("data-app-shell")
  }, [compactShell, bypass])

  // Defense-in-depth against the SSR/hydration paint: until effects run,
  // `usePlatform()` returns the server snapshot ("web") and `usePathname()`
  // can briefly disagree with the post-hydration value. Bypass routes
  // (/share-target, /pair, /oauth, /canvas/join) must render full-bleed with
  // no chrome and no delay — Capacitor visiting /pair must never flash any
  // desktop chrome — so they keep returning children. For ordinary routes,
  // cover the boot/hydration gap with a neutral loader instead of a
  // half-painted shell (the static-export HTML shows this until JS mounts).
  // The loader stands for the boot screen's `interface` step, so the timeline
  // it shows continues from the gates above rather than restarting.
  if (!mounted)
    return bypass ? (
      <>{children}</>
    ) : (
      <PageLoading variant="workspace" milestone="interface" allowReload />
    )
  if (compactShell || bypass) return <>{children}</>

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
  //
  // Always mounted, and told to collapse rather than being swapped for `null`:
  // both reasons the column goes away are gestures the user watches, and a CSS
  // transition needs the element on both sides of the change. `sidebarHostsNav`
  // matters most — it flips *with* the conversation sidebar's own width
  // animation, so unmounting here ended a smooth collapse on a 56px jolt in the
  // opposite direction.
  const guildRail = (
    <GuildRail
      collapsed={guildRailCollapsed || sidebarHostsNav}
      onCreateTeam={handleCreateTeam}
      onOpenSettings={() => handleOpenSettings()}
    />
  )

  return (
    // The provider is what lets the chat workspace's column headers render into
    // the title bar's outlets (`components/shell/title-bar-outlets.tsx`); it
    // has to sit above both the bar and the routed children.
    <TitleBarOutletsProvider>
      <div className="relative flex h-screen w-full flex-col bg-background text-foreground">
        <WindowFocusTracker />
        <WindowResizeEdges />
        <ZoomShortcuts />
        <TerminalToggleShortcut />
        <PanelQuickSwitch />
        <TitleBar />
        {/* Residual notice for a first run the user left early (ADR-0122).
          Mounted here rather than at the body level: this shell is `h-screen`
          and the body it sits in is `overflow:hidden`, so an in-flow bar after
          the shell was laid out past the bottom edge and clipped — visible on
          no route. As a row of the shell's own column it takes real height and
          the content row below simply absorbs it. Self-hiding, so the normal
          path costs one selector. */}
        <FinishSetupBar />
        {/* Owns the dock's drag-to-move context. Renders no DOM of its own; the
          edge drop zones it paints during a drag are `fixed`, so the row's
          child order (which the rail-placement tests pin) is unchanged. */}
        <TerminalDockMoveProvider>
          <div className="flex flex-1 overflow-hidden">
            {sidebarSide === "left" ? guildRail : null}
            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
              <div data-find-scope className="flex min-h-0 flex-1 overflow-hidden">
                <AgentExecutionHandleProvider>{children}</AgentExecutionHandleProvider>
              </div>
              <TerminalDockRegion slot="bottom" />
            </div>
            {/* Right-docked terminal. Sits inboard of the extension host bar and
              the rail so those stay pinned to the window edge. */}
            <TerminalDockRegion slot="right" />
            {/*
             * VS Code extension host bar — hosts webviews + terminals from
             * any activated extension. Returns `null` until an extension
             * registers a surface, so the layout is unchanged in the
             * default case. Phase A4 of the LSP reuse work.
             */}
            <VscodeExtensionHostBar className="hidden w-72 shrink-0 border-l lg:flex" />
            {sidebarSide === "right" ? guildRail : null}
          </div>
        </TerminalDockMoveProvider>
        {mounted && <CommandPalette onOpenSettings={handleOpenSettings} />}
        <FindBar />
        {/* Global, like the palette beside it. It used to live inside the terminal
          dock, which renders only while that panel is open — so clicking a file
          reference in chat with the terminal closed wrote to the store and showed
          nothing at all. */}
        <FileViewerDialog />
        {/* The four workspace editors, mounted once so the command palette
            can open one. The palette closes before it runs an action, so it
            cannot mount what the action opens. */}
        <WorkspaceDialogHost />
        <ShellLayoutNotice />
        {/* Collapses to zero height on the same clock rather than unmounting —
          hiding it used to drop 24px out of the window in one frame. */}
        <StatusBar collapsed={statusBarCollapsed} />
      </div>
    </TitleBarOutletsProvider>
  )
}
