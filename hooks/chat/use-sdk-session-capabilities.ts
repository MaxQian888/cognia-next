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
 * Returns `null` lists when unavailable (a standalone browser with no host,
 * unsupported runtime, no open session). The host question is the host profile, not
 * the webview kind: a paired phone or browser drives `claude_session_control`
 * on the host's sidecar over the companion transport.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import {
  agentHostAvailable,
  resolveAgentExecutionEnvironment,
} from "@/lib/ai/agent/execution/host-environment"
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
  const runtimeScope = useChatStore((s) => {
    const execution = sessionId ? s.lastSendBySession?.[sessionId]?.options.execution : undefined
    return execution ? `${execution.hostRef}:${execution.runtimeAdapter}` : ""
  })
  const [models, setModels] = useState<SdkModelInfo[] | null>(null)
  const [commands, setCommands] = useState<SdkSlashCommand[] | null>(null)

  const enabled = agentHostAvailable(resolveAgentExecutionEnvironment()) && !!sessionId

  // The live host owns runtime selection; a custom provider may also run the
  // Claude SDK. Unsupported runtimes are probed once per scope, not each turn.
  const scope = enabled ? `${sessionId}:${providerId ?? ""}:${runtimeScope}` : null
  const requestState = useRef({ scope, generation: 0, unsupported: new Set<string>() })
  useLayoutEffect(() => {
    requestState.current = {
      scope,
      generation: requestState.current.generation + 1,
      unsupported: new Set(),
    }
    return () => {
      requestState.current.generation += 1
    }
  }, [scope])

  const refresh = useCallback(() => {
    if (!enabled || !sessionId) return
    const generation = ++requestState.current.generation
    const current = () =>
      requestState.current.scope === scope && requestState.current.generation === generation
    if (!requestState.current.unsupported.has("getSessionSupportedModels")) {
      getSessionSupportedModels(sessionId)
        .then((value) => {
          if (current()) setModels(value)
        })
        .catch((error: unknown) => {
          if (!current()) return
          if (String(error).includes("unsupported"))
            requestState.current.unsupported.add("getSessionSupportedModels")
          setModels(null)
        })
    }
    if (!requestState.current.unsupported.has("getSessionSupportedCommands")) {
      getSessionSupportedCommands(sessionId)
        .then((value) => {
          if (current()) setCommands(value)
        })
        .catch((error: unknown) => {
          if (!current()) return
          if (String(error).includes("unsupported"))
            requestState.current.unsupported.add("getSessionSupportedCommands")
          setCommands(null)
        })
    }
  }, [enabled, sessionId, scope])

  // Clear stale lists on session / eligibility change during render (avoids a
  // synchronous setState in an effect).
  const resetKey = scope
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
