"use client"

/**
 * Binds the issue surface's page-scoped keyboard map.
 *
 * Listens on `document` rather than on a focused container because the board
 * has no single focusable root — the user may be anywhere on the page when
 * they press `c`. The typing guard in `resolveIssueShortcut` is what keeps
 * that from eating characters out of the search box.
 *
 * Only handlers that are actually supplied consume their key: an unhandled
 * action falls through so browser and app-level bindings still work.
 */

import { useEffect, useRef } from "react"

import { resolveIssueShortcut, type IssueShortcutAction } from "@/lib/issues/shortcuts"

export type IssueShortcutHandlers = Partial<Record<IssueShortcutAction, () => void>>

export function useIssueShortcuts(handlers: IssueShortcutHandlers, enabled = true): void {
  // Kept in a ref so a handler identity change (every render, since callers
  // build these inline) does not detach and re-attach the listener. Written in
  // an effect rather than during render — `react-hooks/refs` bans the latter,
  // and the listener cannot fire before effects have flushed anyway.
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      const action = resolveIssueShortcut(event)
      if (!action) return
      const handler = latest.current[action]
      if (!handler) return
      event.preventDefault()
      handler()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [enabled])
}
