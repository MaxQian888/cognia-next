"use client"

/**
 * Rebindable keyboard shortcuts for the observability dashboard, registered
 * while it is mounted:
 *
 *   observability.toggleEdit   e → toggle edit/lock layout
 *   observability.refresh      r → refresh now
 *   observability.focusFilter  f → focus the filter bar
 *   observability.openSettings s → open settings
 *
 * The single dispatcher owns the listener, the editable guard (so the keys type
 * normally in a field), and the modifier guard (a held modifier makes a
 * different chord that won't match). `preventDefault` fires only when a handler
 * is present, matching the pre-migration behavior.
 */

import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

export interface HotkeyHandlers {
  onToggleEdit?: () => void
  onRefresh?: () => void
  onFocusFilter?: () => void
  onOpenSettings?: () => void
}

function run(event: KeyboardEvent, fn: (() => void) | undefined): void {
  if (!fn) return
  event.preventDefault()
  fn()
}

export function useObservabilityHotkeys(handlers: HotkeyHandlers): void {
  useAppShortcut("observability.toggleEdit", (e) => run(e, handlers.onToggleEdit))
  useAppShortcut("observability.refresh", (e) => run(e, handlers.onRefresh))
  useAppShortcut("observability.focusFilter", (e) => run(e, handlers.onFocusFilter))
  useAppShortcut("observability.openSettings", (e) => run(e, handlers.onOpenSettings))
}
