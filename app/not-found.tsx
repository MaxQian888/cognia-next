"use client"

/**
 * Root 404 page. Fires for any path that doesn't match a route and for
 * `notFound()` calls from segments that don't ship their own `not-found.tsx`.
 *
 * Because this file lives inside the layout tree, `DesktopAppShell` keeps the
 * TitleBar / GuildRail / StatusBar mounted while the 404 renders.
 */

import { ErrorPage } from "@/components/error/error-page"

export default function GlobalNotFound() {
  return <ErrorPage variant="not-found" />
}
