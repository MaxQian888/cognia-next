"use client"

/**
 * Mobile mount of the unified global search on every route except `/`
 * (ADR-0129).
 *
 * `AppShellMobile` renders only on `/`, and it mounts `MobileCommandPalette`
 * with the two behaviours only the home shell can provide (its character
 * picker for "new chat", closing the navigation drawer after picking a
 * conversation). Every other mobile route — `/settings`, `/inbox`, `/me/*`,
 * `/memory`, … — had no mount at all, so ⌘K and the settings header's search
 * button dispatched into nothing there. This host fills exactly that gap:
 * it renders `null` on `/` so the two never coexist, and elsewhere opens the
 * same dialog with a router-only host (a picked conversation is focused and
 * the app returns to the chat route).
 */

import { usePathname, useRouter } from "next/navigation"
import { useMemo } from "react"

import { GlobalSearchDialog } from "@/components/global-search/global-search-dialog"
import type { GlobalSearchHost } from "@/hooks/global-search/use-global-search-actions"

export function MobileGlobalSearchHost() {
  const pathname = usePathname()
  const router = useRouter()
  const host = useMemo<GlobalSearchHost>(
    () => ({
      // The mobile settings route reads `?section=` only; a focused control
      // degrades to its section, which `useSettingFocus` already tolerates.
      onOpenSettings: (tab) => router.push(tab ? `/settings?section=${tab}` : "/settings"),
    }),
    [router]
  )
  // The home shell owns the mount on `/` — see the file header.
  if ((pathname ?? "/") === "/") return null
  return <GlobalSearchDialog host={host} />
}
