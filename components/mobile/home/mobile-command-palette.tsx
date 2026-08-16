"use client"

/**
 * Mobile mount of the unified global search (ADR-0129).
 *
 * The home shell keeps driving it from its search bar and quick-action grid
 * (`open` / `onOpenChange`), and keeps owning the two shell-specific effects:
 * "new chat" opens the character picker, and selecting a session also closes
 * the navigation drawer. Everything else — scopes, filters, every provider —
 * is the same dialog the desktop mounts.
 */

import { useMemo } from "react"

import { GlobalSearchDialog } from "@/components/global-search/global-search-dialog"
import type { GlobalSearchHost } from "@/hooks/global-search/use-global-search-actions"

export interface MobileCommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Start a new chat (opens the shell's character picker). */
  onNewChat: () => void
  /** Resume a session by id. */
  onSelectSession: (id: string) => void
  /** Open settings (optionally a section). */
  onOpenSettings: (tab?: string) => void
}

export function MobileCommandPalette({
  open,
  onOpenChange,
  onNewChat,
  onSelectSession,
  onOpenSettings,
}: MobileCommandPaletteProps) {
  const host = useMemo<GlobalSearchHost>(
    () => ({
      // The mobile settings route reads `?section=` only; a focused control
      // degrades to its section, which `useSettingFocus` already tolerates.
      onOpenSettings: (tab) => onOpenSettings(tab),
      onNewChat,
      onSelectSession,
    }),
    [onOpenSettings, onNewChat, onSelectSession]
  )
  return <GlobalSearchDialog host={host} open={open} onOpenChange={onOpenChange} />
}
