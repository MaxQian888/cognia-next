"use client"

/**
 * Root segment error boundary. Wraps every route under `app/` except those
 * with their own `error.tsx` (currently `/scheduler` and `/share-target`).
 *
 * Because this file lives inside the layout tree, `DesktopAppShell` keeps the
 * TitleBar / GuildRail / StatusBar mounted while the error UI renders — users
 * stay able to close the window, switch routes, or hit the command palette.
 */

import { ErrorPage } from "@/components/error/error-page"

export default function GlobalRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <ErrorPage variant="error" error={error} reset={reset} />
}
