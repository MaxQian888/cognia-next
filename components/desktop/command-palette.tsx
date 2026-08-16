"use client"

/**
 * Desktop mount of the unified global search (ADR-0129).
 *
 * The 600-line palette that used to live here — its own ⌘K listener, its own
 * copies of the session / character / team / workspace groups — is now
 * `components/global-search/global-search-dialog.tsx`, shared with mobile.
 * This adapter keeps the `CommandPalette` name and `onOpenSettings` prop that
 * `desktop-app-shell.tsx` mounts, and adds the one desktop-specific behaviour:
 * a settings hit with a `focus` control deep-links to `?section=&focus=` so
 * `useSettingFocus` can scroll-and-highlight it.
 */

import { useRouter } from "next/navigation"
import { useCallback, useMemo } from "react"

import { GlobalSearchDialog } from "@/components/global-search/global-search-dialog"
import type { GlobalSearchHost } from "@/hooks/global-search/use-global-search-actions"

interface Props {
  onOpenSettings: (tab?: string) => void
}

export function CommandPalette({ onOpenSettings }: Props) {
  const router = useRouter()
  const openSettings = useCallback(
    (tab?: string, focus?: string) => {
      if (tab && focus) {
        router.push(
          `/settings?section=${encodeURIComponent(tab)}&focus=${encodeURIComponent(focus)}`
        )
        return
      }
      onOpenSettings(tab)
    },
    [router, onOpenSettings]
  )
  const host = useMemo<GlobalSearchHost>(() => ({ onOpenSettings: openSettings }), [openSettings])
  return <GlobalSearchDialog host={host} />
}
