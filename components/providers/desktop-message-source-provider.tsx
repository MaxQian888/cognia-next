"use client"

import { useEffect } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { installDesktopMessageSource } from "@/lib/companion/desktop-message-source"
import { installDesktopWriteSource } from "@/lib/companion/desktop-write-source"
import { installCliRendererRequestSource } from "@/lib/cli-bridge/renderer-request-source"
import { installWasmRendererRequestSource } from "@/lib/plugin/wasm-bridge"

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
    // CLI bridge renderer round-trips (twin context / agent teams) ride the
    // same provider lifecycle — Tauri-only, torn down with the others.
    void installCliRendererRequestSource().then((unsub) => {
      if (cancelled) {
        unsub()
        return
      }
      teardowns.push(unsub)
    })
    // WASM plugin capability bridge (ADR-0013 api-version 0.2): `ai.generate-
    // text` and `workflow.emit-event` need the provider chain, the PII gate,
    // and the trigger registry, all of which live here in the renderer. Same
    // Tauri-only lifecycle; on web/mobile the host answers HOST_UNAVAILABLE
    // rather than emulating them.
    void installWasmRendererRequestSource().then((unsub) => {
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
