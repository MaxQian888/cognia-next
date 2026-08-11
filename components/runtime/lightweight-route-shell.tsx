"use client"

import { usePathname } from "next/navigation"

/**
 * Routes that must not boot the authenticated application runtime.
 *
 * Overlay routes run in small secondary Tauri windows. `/status` is a public,
 * read-only document. Both need locale/theme providers but must bypass account
 * gating, plugin boot, schedulers, companion bridges, and desktop/mobile chrome.
 */
const LIGHTWEIGHT_ROUTE_PREFIXES = [
  "/status",
  "/pet-overlay",
  "/pet-popup",
  "/island",
  "/selection-toolbar",
] as const

export function isLightweightRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return LIGHTWEIGHT_ROUTE_PREFIXES.some(
    (prefix) =>
      pathname === prefix ||
      pathname === `${prefix}.html` ||
      pathname === `${prefix}/` ||
      pathname.startsWith(`${prefix}/`)
  )
}

export function LightweightRouteShell({
  lightweightShell,
  children,
}: {
  lightweightShell: React.ReactNode
  children: React.ReactNode
}) {
  const pathname = usePathname()
  return <>{isLightweightRoute(pathname) ? lightweightShell : children}</>
}
