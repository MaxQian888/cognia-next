/**
 * One fetch of an external agent's models, shared by everything that renders
 * them.
 *
 * Two surfaces need the same answer at the same moment: the composer's model
 * chip and the session panel's config rows. Both mount together in the chat
 * view, and both would otherwise send the agent its own round trip on every
 * connect. For Pi that round trip is a real RPC to a real process
 * (`get_available_models`), so the duplicate is not free.
 *
 * The cache is deliberately per (agent, session) and deliberately not a
 * timer: an agent's model list changes when the user changes it, and this
 * module is told so by the writer rather than discovering it by polling. Call
 * {@link loadAgentModelSurface} with `refresh` after a write, and
 * {@link forgetAgentModelSurface} when an agent disconnects.
 */

import { computeBackoffDelay } from "@cognia/primitives/backoff"

import { externalAgentProcessPlaneScope } from "./process-plane"
import {
  EMPTY_THINKING_SURFACE,
  type ExternalAgentModelSurface,
  type ExternalAgentThinkingSurface,
} from "./session-models"

export type ModelSurfaceStatus = "ready" | "unsupported" | "error"

/**
 * Everything one `session/config_options` round trip can answer.
 *
 * The models and the thinking ladder arrive in the SAME reply and are read by
 * two controls that mount together on the composer toolbar, so they travel as
 * one result. Splitting them would double the round trip this module exists to
 * avoid, and would let the model chip and the effort chip describe two
 * different moments of the agent's state.
 */
export interface ExternalAgentSessionSurface {
  models: ExternalAgentModelSurface
  thinking: ExternalAgentThinkingSurface
}

export interface ModelSurfaceResult {
  status: ModelSurfaceStatus
  surface: ExternalAgentModelSurface
  /** What the agent published on its thinking axis in the same reply. */
  thinking: ExternalAgentThinkingSurface
  /** Present on `error`, for diagnostics rather than for a badge. */
  detail?: string
}

/**
 * What a surface looks like when there is nothing to offer.
 *
 * Exported because a caller can fail BEFORE the agent is reachable at all (a
 * host-owned configuration whose mount was refused), and reporting that as
 * `unsupported` would tell the user the agent has no models when in fact it
 * was never asked.
 */
export const EMPTY_MODEL_SURFACE: ExternalAgentModelSurface = {
  choices: [],
  currentModelId: null,
  write: { kind: "none" },
}

const cache = new Map<string, ModelSurfaceResult>()
const inFlight = new Map<string, Promise<ModelSurfaceResult>>()
/** Monotonic per key, so a load can tell whether a newer one has started. */
const issued = new Map<string, number>()
/**
 * Failed attempts per key, and the moment the next one is allowed.
 *
 * An `error` answer used to be cached exactly like a `ready` one, with no
 * expiry, so an agent that was asked one moment too early stayed "has no
 * models" for the life of the tab. The only way back was reopening the model
 * popover, which is the one action a user has no reason to take when the
 * picker is telling them there is nothing to pick.
 */
const failures = new Map<string, { attempts: number; retryAt: number }>()
/** Which machine the cached answers describe. See `retireStaleScope`. */
let cachedScope: string | null = null
const listeners = new Set<() => void>()
let revision = 0

/** First retry a second out, capped at half a minute, with the usual jitter. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000

function key(agentId: string, sessionId: string): string {
  return `${agentId}\u0000${sessionId}`
}

/**
 * Wake every reader after a write.
 *
 * The composer mounts TWO copies of `useExternalAgentModels`: the model picker
 * and the effort chip, each with its own `nonce`. Refreshing from the picker
 * updated this module and neither copy of the other hook, so the effort chip
 * kept rendering a ladder from before the refresh until it remounted. A cache
 * shared by two consumers has to be able to tell them it changed.
 */
export function subscribeAgentModelSurface(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(): void {
  revision += 1
  for (const listener of [...listeners]) listener()
}

/**
 * Drop everything the moment the process plane points somewhere else.
 *
 * A cached answer is about the machine that produced it. Repointing a browser
 * at a second Host does not make the old answer stale so much as make it about
 * somebody else, and this module had no way to notice: `installed-runtimes`
 * already guards its cache this way and this one did not.
 */
function retireStaleScope(): void {
  const scope = externalAgentProcessPlaneScope()
  if (cachedScope !== null && cachedScope !== scope) forgetAgentModelSurface()
  cachedScope = scope
}

/** What the last load found, or `null` when this pair was never loaded. */
export function cachedAgentModelSurface(
  agentId: string,
  sessionId: string
): ModelSurfaceResult | null {
  return cache.get(key(agentId, sessionId)) ?? null
}

/**
 * Drop what is cached.
 *
 * With no argument, everything. With an agent id, only that agent's sessions,
 * which is what a disconnect should do: the next connect may be a different
 * process with a different model list, and answering from the old one would
 * offer models the new agent does not have.
 */
export function forgetAgentModelSurface(agentId?: string): void {
  // Tickets are bumped, never cleared. A fetch already in flight resolves
  // after this returns, and with no newer stamp to lose to it would write
  // the very entry that was just dropped straight back into the cache.
  const invalidate = (id: string) => {
    issued.set(id, (issued.get(id) ?? 0) + 1)
    cache.delete(id)
    inFlight.delete(id)
    failures.delete(id)
  }
  const keys = [...new Set([...cache.keys(), ...inFlight.keys(), ...failures.keys()])]
  if (!agentId) {
    for (const entry of keys) invalidate(entry)
    publish()
    return
  }
  const prefix = `${agentId}\u0000`
  for (const entry of keys) if (entry.startsWith(prefix)) invalidate(entry)
  publish()
}

/** Injected so the loader is testable without standing up a manager. */
export interface ModelSurfaceLoaderDeps {
  fetchSurface: (
    agentId: string,
    sessionId: string
  ) => Promise<
    | { status: "ok"; data: ExternalAgentSessionSurface }
    | { status: "unsupported" }
    | { status: "error"; error: Error }
  >
}

/**
 * The reserved "session" under which an agent's session-less catalog is
 * cached. Not a real session id: Pi ids are UUIDs and ACP ids are opaque
 * strings from the agent, neither of which can be this.
 */
export const AGENT_MODEL_CATALOG = "*catalog*"

const defaultDeps: ModelSurfaceLoaderDeps = {
  fetchSurface: async (agentId, sessionId) => {
    const { getExternalAgentManager } = await import("./manager")
    if (sessionId === AGENT_MODEL_CATALOG) {
      return getExternalAgentManager().fetchAgentModelCatalog(agentId)
    }
    return getExternalAgentManager().fetchSessionModelSurface(agentId, sessionId)
  },
}

let deps: ModelSurfaceLoaderDeps = defaultDeps

/** Test seam. Returns a restore function. */
export function __setModelSurfaceDepsForTests(next: Partial<ModelSurfaceLoaderDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

/**
 * Ask the agent, once, unless told to ask again.
 *
 * Never rejects: an agent that cannot answer is a fact the caller renders, and
 * a throw here would surface as an unhandled rejection in the effect that
 * kicked it off.
 */
export async function loadAgentModelSurface(
  agentId: string,
  sessionId: string,
  { refresh = false } = {}
): Promise<ModelSurfaceResult> {
  retireStaleScope()
  const id = key(agentId, sessionId)
  if (!refresh) {
    const hit = cache.get(id)
    // An `error` is a moment, not a fact about the agent. It is served from
    // cache only until its backoff expires, and then the next reader retries
    // on its own. `ready` and `unsupported` are answers the agent gave and
    // stay until something invalidates them.
    if (hit && (hit.status !== "error" || (failures.get(id)?.retryAt ?? 0) > Date.now())) return hit
    const pending = inFlight.get(id)
    if (pending) return pending
  }

  // Every load is stamped, and only the newest one is allowed to write the
  // cache or to clear the in-flight slot. A `refresh` fired after a write races
  // the plain load the surface mounted with: without this the slower of the two
  // wins whichever it is, so a stale pre-write answer could land on top of the
  // fresh one, and the first `finally` to run deleted the slot belonging to the
  // request still outstanding.
  const ticket = (issued.get(id) ?? 0) + 1
  issued.set(id, ticket)
  const isNewest = () => issued.get(id) === ticket

  const request = deps
    .fetchSurface(agentId, sessionId)
    .then((result): ModelSurfaceResult => {
      if (result.status === "ok") {
        return { status: "ready", surface: result.data.models, thinking: result.data.thinking }
      }
      if (result.status === "unsupported") {
        return {
          status: "unsupported",
          surface: EMPTY_MODEL_SURFACE,
          thinking: EMPTY_THINKING_SURFACE,
        }
      }
      return {
        status: "error",
        surface: EMPTY_MODEL_SURFACE,
        thinking: EMPTY_THINKING_SURFACE,
        detail: result.error.message,
      }
    })
    .catch((error: unknown): ModelSurfaceResult => ({
      status: "error",
      surface: EMPTY_MODEL_SURFACE,
      thinking: EMPTY_THINKING_SURFACE,
      detail: error instanceof Error ? error.message : String(error),
    }))
    .then((result) => {
      if (isNewest()) {
        cache.set(id, result)
        if (result.status === "error") {
          const attempts = (failures.get(id)?.attempts ?? 0) + 1
          failures.set(id, {
            attempts,
            retryAt:
              Date.now() +
              computeBackoffDelay(attempts - 1, {
                baseDelayMs: RETRY_BASE_MS,
                maxDelayMs: RETRY_MAX_MS,
                // The same ratio jitter the reconnect paths use, so several
                // surfaces that failed together do not retry in lockstep.
                jitter: { kind: "ratio", ratio: 0.25 },
              }),
          })
        } else {
          failures.delete(id)
        }
        publish()
      }
      return result
    })
    .finally(() => {
      if (isNewest()) inFlight.delete(id)
    })

  inFlight.set(id, request)
  return request
}

/**
 * The agent's catalog before any session is open, cached under
 * {@link AGENT_MODEL_CATALOG} so a disconnect (`forgetAgentModelSurface`)
 * drops it with the agent's session entries.
 */
export function loadAgentModelCatalog(
  agentId: string,
  options: { refresh?: boolean } = {}
): Promise<ModelSurfaceResult> {
  return loadAgentModelSurface(agentId, AGENT_MODEL_CATALOG, options)
}

/**
 * A counter that moves on every write.
 *
 * `useSyncExternalStore` needs a snapshot value, and the cache itself is a Map
 * whose identity never changes. A revision is the smallest thing that can
 * change, so two hooks reading one cache both re-render when it does.
 */
export function agentModelSurfaceRevision(): number {
  return revision
}
