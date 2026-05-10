"use client"

/**
 * Desktop App Shell — owns the global desktop chrome (TitleBar, GuildRail,
 * StatusBar, CommandPalette, window observers) so every desktop route
 * inherits a unified frame. Mounted from `app/layout.tsx` between
 * `MobileShellWrapper` and the routed children.
 *
 *   ┌────────── TitleBar ──────────┐  ← always mounted (close button lives here)
 *   │ Guild │  {children}           │  ← page-specific content
 *   │ Rail  │                       │
 *   ├──────────── StatusBar ────────┤
 *
 * - On mobile (`platform === "mobile"`) this component is a no-op so
 *   `MobileShellWrapper` keeps full ownership of the layout.
 * - On bypass routes (deep-link / overlay screens like `/share-target`,
 *   `/pair`, `/oauth`, `/canvas/join`) the chrome is suppressed so the
 *   target screen renders full-bleed.
 */

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import { CommandPalette } from "@/components/desktop/command-palette"
import { GuildRail } from "@/components/desktop/guild-rail"
import { StatusBar } from "@/components/desktop/status-bar"
import { TitleBar } from "@/components/desktop/title-bar"
import { WindowFocusTracker } from "@/components/desktop/window-focus-tracker"
import { WindowResizeEdges } from "@/components/desktop/window-resize-edges"
import { ZoomShortcuts } from "@/components/desktop/zoom-shortcuts"
import { usePlatform } from "@/hooks/use-platform"
import { whenSeeded } from "@/lib/db/schema"
import { loggers } from "@/lib/logger"

const log = loggers.shell

const BYPASS_PREFIXES = ["/share-target", "/pair", "/oauth", "/canvas/join"]

export function isShellBypassRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return BYPASS_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

export function DesktopAppShell({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()
  const pathname = usePathname()
  const router = useRouter()

  const bypass = isShellBypassRoute(pathname)
  const isMobile = platform === "mobile"

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
    void whenSeeded()
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

  if (isMobile || bypass) return <>{children}</>

  const handleCreateTeam = () => {
    log.info("guild create-team via shell")
    router.push("/settings?section=teams")
  }
  const handleOpenSettings = (tab?: string) => {
    log.info("open settings via shell", { tab: tab ?? "general" })
    router.push(tab ? `/settings?section=${tab}` : "/settings")
  }

  return (
    <div className="relative flex h-screen w-full flex-col bg-background text-foreground">
      <WindowFocusTracker />
      <WindowResizeEdges />
      <ZoomShortcuts />
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <GuildRail onCreateTeam={handleCreateTeam} onOpenSettings={() => handleOpenSettings()} />
        <div className="flex min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
      {mounted && <CommandPalette onOpenSettings={handleOpenSettings} />}
      <StatusBar />
    </div>
  )
}
