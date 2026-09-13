"use client"

/**
 * Fetches the Claude Agent SDK's authoritative context-window usage for the
 * active session via the live `getContextUsage()` control method (see
 * `lib/claude/ipc.ts:getSessionContextUsage`). The SDK knows the TRUE window
 * size and a per-category token breakdown (system-prompt sections, MCP tools,
 * memory files, agents, skills) that the renderer-side estimate in
 * `lib/claude/usage.ts` can't compute.
 *
 * Returns `null` when unavailable (web, unsupported runtime, no open
 * session, or before the first turn) so the indicator falls back cleanly to the
 * message-derived estimate. Refreshes once after each completed turn.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import {
  agentHostAvailable,
  resolveAgentExecutionEnvironment,
} from "@/lib/ai/agent/execution/host-environment"
import { getSessionContextUsage } from "@/lib/claude/ipc"
import type { SdkContextUsage } from "@cognia/agent-config-types"
import { useChatStore, useSessionStatus } from "@/stores/chat"

/** Statuses during which a turn is in flight (no fresh context to read yet). */
function isBusy(status: string | undefined): boolean {
  return status === "streaming" || status === "awaiting_approval"
}

export function useSdkContextUsage(
  sessionId: string | null,
  providerId?: string
): { snapshot: SdkContextUsage | null; refresh: () => void } {
  const status = useSessionStatus(sessionId)
  const runtimeScope = useChatStore((s) => {
    const execution = sessionId ? s.lastSendBySession?.[sessionId]?.options.execution : undefined
    return execution ? `${execution.hostRef}:${execution.runtimeAdapter}` : ""
  })
  const [snapshot, setSnapshot] = useState<SdkContextUsage | null>(null)

  // A local or paired host can report which controls the selected runtime supports.
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
    if (!requestState.current.unsupported.has("getSessionContextUsage")) {
      getSessionContextUsage(sessionId)
        .then((value) => {
          if (current()) setSnapshot(value)
        })
        .catch((error: unknown) => {
          if (!current()) return
          if (String(error).includes("unsupported"))
            requestState.current.unsupported.add("getSessionContextUsage")
          setSnapshot(null)
        })
    }
  }, [enabled, sessionId, scope])

  // Clear stale data when the session (or eligibility) changes — done during
  // render (React's recommended pattern) so it isn't a synchronous setState in
  // an effect. The scope includes the provider so runtime switches clear the snapshot.
  const resetKey = scope
  const [prevKey, setPrevKey] = useState(resetKey)
  if (prevKey !== resetKey) {
    setPrevKey(resetKey)
    setSnapshot(null)
  }

  // Initial fetch when the session becomes eligible.
  useEffect(() => {
    if (enabled && sessionId) refresh()
  }, [enabled, sessionId, refresh])

  // Refresh once after each completed turn (busy → idle transition).
  const prevBusy = useRef(isBusy(status))
  useEffect(() => {
    const was = prevBusy.current
    const now = isBusy(status)
    prevBusy.current = now
    if (was && !now) refresh()
  }, [status, refresh])

  return { snapshot, refresh }
}
