"use client"

/**
 * Fetches the Claude Agent SDK's account-/session-authoritative model and
 * slash-command lists for the active session via the live `supportedModels()`
 * and `supportedCommands()` control methods (see `lib/claude/ipc.ts`).
 *
 * cognia owns its own composer slash menu and multi-provider model catalog —
 * this does NOT replace them. It surfaces what the running SDK session actually
 * exposes (capability flags, agent-facing commands) for diagnostics. The
 * command list is init-captured and can shift mid-session (e.g. after /compact
 * or dynamic skill discovery), so it re-fetches on each completed turn.
 *
 * Returns `null` lists when unavailable (web, non-Anthropic, no open session).
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { isTauri } from "@/lib/tauri"
import {
  getSessionSupportedCommands,
  getSessionSupportedModels,
  subscribeAgentEvents,
} from "@/lib/claude/ipc"
import type { SdkModelInfo, SdkSlashCommand } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"

function isBusy(status: string | undefined): boolean {
  return status === "streaming" || status === "awaiting_approval"
}

export function useSdkSessionCapabilities(
  sessionId: string | null,
  providerId?: string
): {
  models: SdkModelInfo[] | null
  commands: SdkSlashCommand[] | null
  refresh: () => void
} {
  const status = useChatStore((s) => s.status)
  const [models, setModels] = useState<SdkModelInfo[] | null>(null)
  const [commands, setCommands] = useState<SdkSlashCommand[] | null>(null)

  const enabled = isTauri() && !!sessionId && (providerId ?? "anthropic") === "anthropic"

  const refresh = useCallback(() => {
    if (!enabled || !sessionId) return
    getSessionSupportedModels(sessionId)
      .then((m) => setModels(m))
      .catch(() => setModels(null))
    getSessionSupportedCommands(sessionId)
      .then((c) => setCommands(c))
      .catch(() => setCommands(null))
  }, [enabled, sessionId])

  // Clear stale lists on session / eligibility change during render (avoids a
  // synchronous setState in an effect).
  const resetKey = enabled ? sessionId : null
  const [prevKey, setPrevKey] = useState(resetKey)
  if (prevKey !== resetKey) {
    setPrevKey(resetKey)
    setModels(null)
    setCommands(null)
  }

  useEffect(() => {
    if (enabled && sessionId) refresh()
  }, [enabled, sessionId, refresh])

  useEffect(() => {
    if (!enabled || !sessionId) return
    let disposed = false
    let unsubscribe: (() => void) | undefined

    void subscribeAgentEvents((envelope) => {
      if (
        !disposed &&
        envelope.sessionId === sessionId &&
        envelope.event.kind === "commands-changed"
      ) {
        refresh()
      }
    })
      .then((stop) => {
        if (disposed) stop()
        else unsubscribe = stop
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [enabled, refresh, sessionId])

  // The SDK pushes command updates mid-session; re-fetch on a completed turn so
  // a /compact or freshly-discovered skill command isn't stale.
  const prevBusy = useRef(isBusy(status))
  useEffect(() => {
    const was = prevBusy.current
    const now = isBusy(status)
    prevBusy.current = now
    if (was && !now) refresh()
  }, [status, refresh])

  return { models, commands, refresh }
}
