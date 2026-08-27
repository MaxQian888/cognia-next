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
  "/tray-panel",
] as const

/**
 * Lightweight only under `NEXT_PUBLIC_E2E=1`.
 *
 * The plugin-UI surface harness mounts built-in plugins on a bare page, so it
 * must skip the same boot the overlay routes do — but it is a test fixture, not
 * a route the shipped app has, and it stays outside the list above so a
 * production build cannot reach it.
 */
const E2E_LIGHTWEIGHT_ROUTE_PREFIXES = ["/e2e/plugin-ui-surfaces"] as const

function lightweightRoutePrefixes(): readonly string[] {
  return process.env.NEXT_PUBLIC_E2E === "1"
    ? [...LIGHTWEIGHT_ROUTE_PREFIXES, ...E2E_LIGHTWEIGHT_ROUTE_PREFIXES]
    : LIGHTWEIGHT_ROUTE_PREFIXES
}

export function isLightweightRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return lightweightRoutePrefixes().some(
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
