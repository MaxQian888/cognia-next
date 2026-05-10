"use client"

import { useEffect } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { installDesktopMessageSource } from "@/lib/companion/desktop-message-source"
import { installDesktopWriteSource } from "@/lib/companion/desktop-write-source"

/**
 * Tauri-only provider that installs the desktop-side bridge for the
 * `_rpc/message_update`, `_rpc/message_delete`, and `_rpc/session_list`
 * round-trips. Listens for the Rust HTTP handler's three
 * `companion://message-*-request` / `companion://session-list-request`
 * events, runs the matching Dexie call, and ships the result back through
 * the `companion_message_response` Tauri command.
 *
 * No-op on Capacitor (the phone consumes the result, never produces it)
 * and on plain web (no Tauri runtime; nothing to hook into).
 */
export function DesktopMessageSourceProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()

  useEffect(() => {
    if (platform !== "tauri") return
    const teardowns: Array<() => void> = []
    let cancelled = false
    void installDesktopMessageSource().then((unsub) => {
      if (cancelled) {
        unsub()
        return
      }
      teardowns.push(unsub)
    })
    void installDesktopWriteSource().then((unsub) => {
      if (cancelled) {
        unsub()
        return
      }
      teardowns.push(unsub)
    })
    return () => {
      cancelled = true
      for (const fn of teardowns) {
        try {
          fn()
        } catch {
          /* best-effort */
        }
      }
    }
  }, [platform])

  return <>{children}</>
}
