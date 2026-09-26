"use client"

/**
 * The navigation rail's keyboard bindings: ⌥1…⌥9 / Alt+1…Alt+9 open the Nth
 * pinned item, and ⌘, / Ctrl+, opens Settings in the web shell.
 *
 * Bound by the desktop rail (`guild-rail.tsx`, `variant="rail"`), which is
 * mounted for the life of the desktop shell — collapsed, not unmounted, while
 * the sidebar hosts the navigation — so the chords work on every route and in
 * either sidebar state. The mobile drawer's copy of the rail passes
 * `enabled: false`: a phone has no Alt row, and two copies would race for the
 * same registration.
 *
 * The chords, their `when` clauses and the collision notes live in the
 * catalog (`lib/shortcuts/app-catalog.ts`); a rebind in Settings changes what
 * fires here without touching this file.
 */

import { useEffect, useRef } from "react"

import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { registerAppShortcut } from "@/lib/shortcuts/app-runtime"
import {
  PINNED_NAV_SHORTCUT_SLOTS,
  getAppShortcutDescriptor,
  pinnedNavShortcutId,
} from "@/lib/shortcuts/app-catalog"
import type { SidebarCatalogItem } from "@/lib/shell/sidebar-nav"

export interface ShellNavShortcutsOptions {
  /** `false` registers nothing (the mobile drawer's rail). */
  enabled: boolean
  /** The pinned items in rail order — slot N opens `pinned[N - 1]`. */
  pinned: readonly SidebarCatalogItem[]
  goToFeature: (route: string) => void
  openSettings: () => void
}

export function useShellNavShortcuts({
  enabled,
  pinned,
  goToFeature,
  openSettings,
}: ShellNavShortcutsOptions): void {
  // Read through refs so the nine registrations below are made once per
  // mount, not torn down and re-made every time a pin moves.
  const pinnedRef = useRef(pinned)
  const goRef = useRef(goToFeature)
  useEffect(() => {
    pinnedRef.current = pinned
    goRef.current = goToFeature
  })

  useEffect(() => {
    if (!enabled) return
    const disposers = Array.from({ length: PINNED_NAV_SHORTCUT_SLOTS }, (_, index) => {
      const id = pinnedNavShortcutId(index + 1)
      const descriptor = getAppShortcutDescriptor(id)
      return registerAppShortcut({
        id,
        when: descriptor?.when,
        commandId: descriptor?.commandId,
        handler: (event) => {
          // The ⌘K dialog switches its scope tabs on the same chords and
          // consumes them first; a keystroke it already handled is not ours.
          if (event.defaultPrevented) return
          const item = pinnedRef.current[index]
          // An empty slot is inert rather than a jump to some other item.
          if (!item) return
          event.preventDefault()
          goRef.current(item.route)
        },
      })
    })
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [enabled])

  // ⌘, types nothing, so it may fire from inside a field — the same reach
  // the native accelerator has on the desktop build.
  useAppShortcut("shell.settings.open", openSettings, {
    enabled,
    allowInEditable: true,
    preventDefault: true,
  })
}
