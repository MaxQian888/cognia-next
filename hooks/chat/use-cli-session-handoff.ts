"use client"

/**
 * Receive a session handed off from the standalone agent CLI.
 *
 * The CLI POSTs its transcript to the loopback bridge
 * (`src-tauri/src/cli_bridge/handlers.rs::handoff`), which emits
 * `cli-bridge:session-handoff`. This hook listens, materialises the transcript
 * into a continuable chat session (`importHandoffSession`), and makes it the
 * active session so the user can keep going in the desktop app.
 *
 * Mounted once via `CliBridgeEventsBridge` (app/layout.tsx). No-op on
 * web / Capacitor (the bridge isn't running there).
 */

import { useEffect, useRef } from "react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"
import { loggers } from "@/lib/logging"
import { importHandoffSession, type HandoffMessage } from "@/lib/chat/import-handoff-session"
import { useChatStore } from "@/stores/chat/chat-store"

export const SESSION_HANDOFF_EVENT = "cli-bridge:session-handoff"

interface SessionHandoffPayload {
  sessionId: string
  title?: string
  messages?: HandoffMessage[]
  meta?: { provider?: string; model?: string; cwd?: string }
}

export function useCliSessionHandoff(): void {
  const t = useTranslations("cliHandoff")
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    if (!isTauri()) return
    let active = true
    let unlisten: UnlistenFn | undefined

    void (async () => {
      try {
        const off = await listen<SessionHandoffPayload>(SESSION_HANDOFF_EVENT, (event) => {
          const p = event.payload
          if (!p?.sessionId) return
          void (async () => {
            try {
              await importHandoffSession({
                sessionId: p.sessionId,
                title: p.title,
                messages: p.messages ?? [],
                meta: p.meta,
              })
              useChatStore.getState().setActiveSession(p.sessionId)
              loggers.shell.info(`[cli-bridge] session handoff received: ${p.sessionId}`)
              toast.success(tRef.current("received", { title: p.title ?? p.sessionId }))
            } catch (err) {
              loggers.shell.warn(`[cli-bridge] session handoff import failed`, {
                error: String(err),
              })
              toast.error(tRef.current("failed"))
            }
          })()
        })
        if (active) unlisten = off
        else off()
      } catch (err) {
        loggers.shell.warn(`[cli-bridge] failed to subscribe to session handoff`, {
          error: String(err),
        })
      }
    })()

    return () => {
      active = false
      try {
        unlisten?.()
      } catch {
        // already detached
      }
    }
  }, [])
}
