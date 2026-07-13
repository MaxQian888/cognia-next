"use client"

/**
 * Fetches the Claude Agent SDK's authoritative context-window usage for the
 * active session via the live `getContextUsage()` control method (see
 * `lib/claude/ipc.ts:getSessionContextUsage`). The SDK knows the TRUE window
 * size and a per-category token breakdown (system-prompt sections, MCP tools,
 * memory files, agents, skills) that the renderer-side estimate in
 * `lib/claude/usage.ts` can't compute.
 *
 * Returns `null` when unavailable (web, non-Anthropic provider, no open
 * session, or before the first turn) so the indicator falls back cleanly to the
 * message-derived estimate. Refreshes once after each completed turn.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { isTauri } from "@/lib/tauri"
import { getSessionContextUsage } from "@/lib/claude/ipc"
import type { SdkContextUsage } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"

/** Statuses during which a turn is in flight (no fresh context to read yet). */
function isBusy(status: string | undefined): boolean {
  return status === "streaming" || status === "awaiting_approval"
}

export function useSdkContextUsage(
  sessionId: string | null,
  providerId?: string
): { snapshot: SdkContextUsage | null; refresh: () => void } {
  const status = useChatStore((s) => s.status)
  const [snapshot, setSnapshot] = useState<SdkContextUsage | null>(null)

  // Live introspection works only on the Anthropic path (the ai-sdk `q` lacks
  // the control methods) and only inside the desktop shell.
  const enabled = isTauri() && !!sessionId && (providerId ?? "anthropic") === "anthropic"

  const refresh = useCallback(() => {
    if (!enabled || !sessionId) return
    // Best-effort: a `no_active_session` / `unsupported_provider` rejection (or
    // a timeout) clears the snapshot so the estimate path takes over.
    getSessionContextUsage(sessionId)
      .then((u) => setSnapshot(u))
      .catch(() => setSnapshot(null))
  }, [enabled, sessionId])

  // Clear stale data when the session (or eligibility) changes — done during
  // render (React's recommended pattern) so it isn't a synchronous setState in
  // an effect. `resetKey` folds in `enabled` so switching to a non-Anthropic
  // provider also clears the snapshot.
  const resetKey = enabled ? sessionId : null
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
