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

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"

import {
  AGENT_MODEL_CATALOG,
  cachedAgentModelSurface,
  EMPTY_MODEL_SURFACE,
  loadAgentModelCatalog,
  loadAgentModelSurface,
  agentModelSurfaceRevision,
  subscribeAgentModelSurface,
  type ModelSurfaceResult,
} from "@/lib/ai/agent/external/model-surface-cache"
import { mountHostConfigForCatalog } from "@/lib/ai/agent/external/host-config-mount"
import {
  externalAgentProcessPlaneScope,
  subscribeExternalAgentProcessPlane,
} from "@/lib/ai/agent/external/process-plane"
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
  /**
   * A configuration the paired Host owns, when the conversation runs on one.
   *
   * The host lane answered IDLE here, so the picker offered no models and the
   * effort chip no ladder for an agent that has both. The turn then ran on
   * whatever the agent defaults to, which on Pi is its own configured model
   * rather than anything the user chose. The id is the configuration id, which
   * is also the id the host mounts the agent under and the id the persisted
   * `externalAgentProviderId` marker names, so nothing downstream has to know
   * which lane produced it.
   */
  const hostConfigId = runtimeRef.kind === "host" ? runtimeRef.configId : null
  const agentId = runtimeRef.kind === "external" ? runtimeRef.agentId : hostConfigId

  const [externalSessionId, setExternalSessionId] = useState<string | null>(null)
  const [result, setResult] = useState<ModelSurfaceResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  /**
   * Which machine the answer would come from.
   *
   * In the effect's deps, not merely read once, for two reasons. A companion
   * resolves this only after its Host reports its feature manifest and its
   * grants, so a hook that fetched on mount asked before there was anywhere to
   * ask, cached the refusal and stopped. And a browser repointed at a second
   * Host is asking a different machine, which the shared cache also keys on.
   */
  const planeScope = useSyncExternalStore(
    subscribeExternalAgentProcessPlane,
    externalAgentProcessPlaneScope,
    () => "server"
  )
  /**
   * The composer mounts a SECOND copy of this hook for the effort chip, with
   * its own `nonce`. Refreshing from the model popover updated the shared
   * cache and neither copy of the other hook, so the effort ladder stayed on a
   * pre-refresh answer until it remounted. Reading the module's revision here
   * is what makes both copies one view of one cache.
   */
  const cacheRevision = useSyncExternalStore(
    subscribeAgentModelSurface,
    agentModelSurfaceRevision,
    () => 0
  )

  useEffect(() => {
    // No clearing here: the memo below already answers IDLE for a built-in
    // lane, so state left over from a previous agent is unreachable, and
    // clearing it would be a render cascade for a value nothing reads.
    if (!agentId || !sessionId) return
    let cancelled = false
    void (async () => {
      try {
        // A host-owned configuration is not in this shell's agent store, so
        // there is nothing to resolve a session against until it is mounted.
        // Mounting is what makes the catalog readable: on a browser the mount
        // reaches the Host through the process plane, which is the same route
        // the turn itself takes.
        if (hostConfigId) {
          setLoading(true)
          let mountedId: string | null
          try {
            mountedId = await mountHostConfigForCatalog(hostConfigId)
          } catch (cause) {
            // Reported as an error rather than left to fall through. Without
            // the mount the catalog read below finds no adapter and answers
            // `unsupported`, which reads as "this agent has no models" about
            // an agent that was never asked. It is also the only exit here
            // that can reject, and an uncaught one is an unhandled rejection
            // in an effect.
            if (cancelled) return
            setResult({
              status: "error",
              surface: EMPTY_MODEL_SURFACE,
              thinking: EMPTY_THINKING_SURFACE,
              detail: cause instanceof Error ? cause.message : String(cause),
            })
            return
          }
          if (cancelled) return
          if (!mountedId) {
            // The host no longer has this configuration. Not an error: the
            // conversation outlived it, and the picker says so by having
            // nothing to offer rather than by reporting a failure.
            setResult(null)
            return
          }
        }
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
  }, [agentId, hostConfigId, sessionId, nonce, planeScope])

  /**
   * What the shared cache holds right now, derived rather than mirrored.
   *
   * Deliberately not an effect that copies into `result`: the effect above
   * re-fetches whenever `nonce > 0`, so a write-triggered re-run would fetch,
   * publish and fetch again forever, and mirroring one store into another
   * piece of state is the render cascade that rule exists to stop. Reading it
   * during render, keyed on the cache's revision, is the same answer with no
   * second copy to keep in step.
   */
  const shared = useMemo(() => {
    if (!agentId) return null
    // `cacheRevision` is the dependency: it moves on every write, which is
    // exactly when this has to be read again.
    void cacheRevision
    return cachedAgentModelSurface(agentId, externalSessionId ?? AGENT_MODEL_CATALOG)
  }, [agentId, externalSessionId, cacheRevision])
  // The cache wins when it has an answer. `result` covers the frames before
  // the first write lands, and whatever this run of the effect is holding.
  const effective = shared ?? result

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  const select = useCallback(
    async (modelId: string) => {
      // Throw rather than resolve. A silent return is indistinguishable from a
      // completed write to the caller, which then keeps its optimistic chip and
      // its persisted session row while the agent was never told anything.
      if (!agentId || !effective || effective.status !== "ready") {
        throw new Error("The agent has no open session to set a model on")
      }
      // A catalog pick has nowhere to go yet: the caller persists it on the
      // conversation and `applyModelToSession` replays it on the first turn.
      if (effective.surface.write.kind === "session-seed") return
      if (!externalSessionId) {
        throw new Error("The agent has no open session to set a model on")
      }
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      await getExternalAgentManager().selectSessionModel(
        agentId,
        externalSessionId,
        effective.surface,
        modelId
      )
      // Re-read rather than patching the local copy: setting a model can move
      // more than the model (Pi clamps the thinking level to what the new one
      // supports), and a hand-patched surface would hide that.
      const next = await loadAgentModelSurface(agentId, externalSessionId, { refresh: true })
      setResult(next)
    },
    [agentId, externalSessionId, effective]
  )

  return useMemo(() => {
    if (!agentId) return IDLE
    return {
      agentId,
      externalSessionId,
      surface: effective?.status === "ready" ? effective.surface : null,
      thinking: effective?.thinking ?? EMPTY_THINKING_SURFACE,
      loading,
      status: effective?.status ?? "idle",
      select,
      refresh,
    }
  }, [agentId, externalSessionId, effective, loading, select, refresh])
}
