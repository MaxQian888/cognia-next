"use client"

/**
 * The models the external agent bound to THIS conversation will run.
 *
 * Deliberately small and independent of `useExternalAgent`. That hook is the
 * session-runtime surface (events, plans, permissions, compaction) and mounting
 * a second copy of it just to read a model list would double every one of its
 * subscriptions. All this needs is the agent id on the conversation's runtime
 * lane, the session that agent has open, and one cached fetch.
 *
 * It asks on its own rather than waiting for the agent to push: ACP agents send
 * `config_options_update` and therefore worked by luck, while a pull-based
 * adapter (Pi asks its process for `get_available_models`) never pushed
 * anything and left the picker with nothing to show.
 *
 * `null` for the surface means "not asked, or nothing to ask" and a caller must
 * render it as absent, never as "this agent has no models".
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  AGENT_MODEL_CATALOG,
  cachedAgentModelSurface,
  loadAgentModelCatalog,
  loadAgentModelSurface,
  type ModelSurfaceResult,
} from "@/lib/ai/agent/external/model-surface-cache"
import {
  EMPTY_THINKING_SURFACE,
  type ExternalAgentModelSurface,
  type ExternalAgentThinkingSurface,
} from "@/lib/ai/agent/external/session-models"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"

export interface ExternalAgentModels {
  /** The agent this conversation runs on, or `null` on a built-in lane. */
  agentId: string | null
  /** The agent's open session the surface describes. */
  externalSessionId: string | null
  /** What the agent offers. `null` until an answer arrives. */
  surface: ExternalAgentModelSurface | null
  /**
   * The agent's own thinking ladder, from the same reply as `surface`.
   *
   * Empty (rather than `null`) when the agent published none, because the
   * effort control's fallback is a ladder, not an absence: an agent with no
   * `thought_level` option still runs, and the composer keeps offering the
   * generic tiers for it.
   */
  thinking: ExternalAgentThinkingSurface
  loading: boolean
  /** Why there is nothing to show, when the agent was asked and could not say. */
  status: ModelSurfaceResult["status"] | "idle"
  /** Write a chosen model back to the agent, then re-read what it now reports. */
  select: (modelId: string) => Promise<void>
  /**
   * Re-resolve which session the agent has open, and re-ask it for its models.
   *
   * The one thing a caller must drive. The agent opens its session on the first
   * turn and no store announces it, so a hook mounted before that turn resolved
   * `null` and would sit on "nothing open" for the rest of the conversation.
   * The model picker calls this as its popover opens, which is both the moment
   * the answer is about to be read and a deliberate enough action to spend a
   * round trip on.
   */
  refresh: () => void
}

const IDLE: ExternalAgentModels = {
  agentId: null,
  externalSessionId: null,
  surface: null,
  thinking: EMPTY_THINKING_SURFACE,
  loading: false,
  status: "idle",
  select: async () => {},
  refresh: () => {},
}

/** Resolve the agent's open session id. Kept out of render, it hits a singleton. */
async function resolveSessionId(agentId: string, chatSessionId: string): Promise<string | null> {
  const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
  return getExternalAgentManager().resolveConversationSessionId(agentId, chatSessionId)
}

export function useExternalAgentModels(sessionId: string | undefined): ExternalAgentModels {
  const runtimeRef = useRuntimeRefForSession(sessionId)
  const agentId = runtimeRef.kind === "external" ? runtimeRef.agentId : null

  const [externalSessionId, setExternalSessionId] = useState<string | null>(null)
  const [result, setResult] = useState<ModelSurfaceResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    // No clearing here: the memo below already answers IDLE for a built-in
    // lane, so state left over from a previous agent is unreachable, and
    // clearing it would be a render cascade for a value nothing reads.
    if (!agentId || !sessionId) return
    let cancelled = false
    void (async () => {
      try {
        const resolved = await resolveSessionId(agentId, sessionId)
        if (cancelled) return
        setExternalSessionId(resolved)
        if (!resolved) {
          // Connected, but no session yet. An agent that can list its models
          // without one (Pi, via `--list-models`) still answers, so the picker
          // can seed the first turn; every other agent answers `unsupported`
          // and the picker keeps its "arrives with the first turn" notice.
          const cachedCatalog =
            nonce === 0 ? cachedAgentModelSurface(agentId, AGENT_MODEL_CATALOG) : null
          if (cachedCatalog) {
            setResult(cachedCatalog.status === "ready" ? cachedCatalog : null)
            return
          }
          setLoading(true)
          const catalog = await loadAgentModelCatalog(agentId, { refresh: nonce > 0 })
          if (cancelled) return
          setResult(catalog.status === "ready" ? catalog : null)
          return
        }
        const cached = nonce === 0 ? cachedAgentModelSurface(agentId, resolved) : null
        if (cached) {
          setResult(cached)
          return
        }
        setLoading(true)
        const next = await loadAgentModelSurface(agentId, resolved, { refresh: nonce > 0 })
        if (cancelled) return
        setResult(next)
      } finally {
        // Every exit this run owns clears the flag, including the two that
        // never raised it. A run abandoned mid-flight leaves it raised, and
        // the run that replaces it can legitimately answer from cache and
        // return without ever reaching a `setLoading(false)` of its own, so
        // the picker would sit on "asking the agent" for the rest of the
        // conversation. Clearing here is what makes the flag this run's own
        // property rather than a latch shared with whatever comes next.
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId, sessionId, nonce])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  const select = useCallback(
    async (modelId: string) => {
      // Throw rather than resolve. A silent return is indistinguishable from a
      // completed write to the caller, which then keeps its optimistic chip and
      // its persisted session row while the agent was never told anything.
      if (!agentId || !result || result.status !== "ready") {
        throw new Error("The agent has no open session to set a model on")
      }
      // A catalog pick has nowhere to go yet: the caller persists it on the
      // conversation and `applyModelToSession` replays it on the first turn.
      if (result.surface.write.kind === "session-seed") return
      if (!externalSessionId) {
        throw new Error("The agent has no open session to set a model on")
      }
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      await getExternalAgentManager().selectSessionModel(
        agentId,
        externalSessionId,
        result.surface,
        modelId
      )
      // Re-read rather than patching the local copy: setting a model can move
      // more than the model (Pi clamps the thinking level to what the new one
      // supports), and a hand-patched surface would hide that.
      const next = await loadAgentModelSurface(agentId, externalSessionId, { refresh: true })
      setResult(next)
    },
    [agentId, externalSessionId, result]
  )

  return useMemo(() => {
    if (!agentId) return IDLE
    return {
      agentId,
      externalSessionId,
      surface: result?.status === "ready" ? result.surface : null,
      thinking: result?.thinking ?? EMPTY_THINKING_SURFACE,
      loading,
      status: result?.status ?? "idle",
      select,
      refresh,
    }
  }, [agentId, externalSessionId, result, loading, select, refresh])
}
