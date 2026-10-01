/**
 * Keep the running cogset equal to the effective one (ADR-0209).
 *
 * The effective cogset changes when the user switches workspace, when a
 * workspace's binding changes, when the global choice changes (from this
 * window, another device through the host queue, or a restored backup) and
 * when the session override changes. Each of those re-evaluates here, and a
 * difference from what is applied starts an activation.
 *
 * These are automatic switches, so they wait while any agent run is in
 * flight: disabling a plugin under a running turn removes tools that turn is
 * using. The wait is recorded as `pending` on the state row, so the UI can say
 * what is about to happen and why it has not yet. A manual switch from the UI
 * asks the user instead, and calls `activateCogset` itself.
 *
 * Changing the active workspace also clears the session override: an override
 * is "for this workspace, this time", not a new default.
 */

import { loggers } from "@cognia/logging"

import type { CogsetStateRow } from "@/types/plugin/plugin-cogset"

import { resolveEffectiveCogset } from "./effective"

export interface CogsetFollowerDeps {
  getSessionOverride: () => string | undefined
  clearSessionOverride: () => void
  subscribeSession: (listener: () => void) => () => void
  /** The active workspace id and the cogset it binds, if any. */
  getWorkspace: () => { workspaceId: string | null; cogsetId?: string }
  subscribeWorkspace: (listener: () => void) => () => void
  getState: () => Promise<CogsetStateRow>
  subscribeState: (listener: () => void) => () => void
  updateState: (patch: Partial<Omit<CogsetStateRow, "id" | "updatedAt">>) => Promise<unknown>
  cogsetExists: (id: string) => Promise<boolean>
  runsInFlight: () => boolean
  subscribeRuns: (listener: () => void) => () => void
  activate: (cogsetId: string) => Promise<unknown>
  /** The cogset an activation is already moving to. */
  activationTarget: () => string | null
  now: () => number
}

export interface CogsetFollower {
  stop: () => void
  /** Re-evaluate now; resolves when that evaluation (and any activation) is done. */
  evaluate: () => Promise<void>
}

export function startCogsetFollower(deps: CogsetFollowerDeps): CogsetFollower {
  let chain: Promise<void> = Promise.resolve()
  let waitingForRuns = false
  let stopped = false
  let lastWorkspaceId = deps.getWorkspace().workspaceId

  async function evaluateOnce(): Promise<void> {
    if (stopped) return
    const state = await deps.getState()
    const effective = await resolveEffectiveCogset(
      {
        sessionOverrideId: deps.getSessionOverride(),
        workspaceCogsetId: deps.getWorkspace().cogsetId,
        globalCogsetId: state.globalCogsetId,
      },
      deps.cogsetExists
    )
    const target = effective?.cogsetId
    if (!target || target === state.appliedCogsetId || target === deps.activationTarget()) {
      waitingForRuns = false
      if (state.pending) await deps.updateState({ pending: undefined })
      return
    }
    if (deps.runsInFlight()) {
      waitingForRuns = true
      if (state.pending?.cogsetId !== target) {
        await deps.updateState({
          pending: { cogsetId: target, reason: "runs-in-flight", since: deps.now() },
        })
      }
      return
    }
    waitingForRuns = false
    await deps.activate(target)
  }

  function evaluate(): Promise<void> {
    const next = chain.then(evaluateOnce)
    chain = next.catch((error) => {
      loggers.plugin.warn("cogset follower evaluation failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return chain
  }

  const unsubscribers = [
    deps.subscribeSession(() => void evaluate()),
    deps.subscribeWorkspace(() => {
      const { workspaceId } = deps.getWorkspace()
      if (workspaceId !== lastWorkspaceId) {
        lastWorkspaceId = workspaceId
        deps.clearSessionOverride()
      }
      void evaluate()
    }),
    deps.subscribeState(() => void evaluate()),
    deps.subscribeRuns(() => {
      // Only a deferred switch cares that runs settled.
      if (waitingForRuns && !deps.runsInFlight()) void evaluate()
    }),
  ]

  void evaluate()

  return {
    stop: () => {
      stopped = true
      for (const off of unsubscribers) off()
    },
    evaluate,
  }
}

/** The production wiring. Call only on a host that owns its plugin runtime. */
export async function startDefaultCogsetFollower(): Promise<CogsetFollower> {
  const [
    { liveQuery },
    { getDb },
    cogsets,
    { useCogsetSessionStore },
    { useProjectStore },
    { getExecutionBroker },
    reconcile,
  ] = await Promise.all([
    import("dexie"),
    import("@/lib/db/schema"),
    import("@/lib/db/plugin-cogsets"),
    import("@/stores/plugins/cogset-session-store"),
    import("@/stores/project/project-store"),
    import("@/lib/execution/broker"),
    import("./reconcile"),
  ])
  const { setActiveCogsetFollower } = await import("./follower-registry")
  const broker = getExecutionBroker()
  const workspace = () => {
    const { activeProjectId, projects } = useProjectStore.getState()
    const active = projects.find((project) => project.id === activeProjectId)
    return { workspaceId: activeProjectId, cogsetId: active?.pluginCogsetId }
  }
  const follower = startCogsetFollower({
    getSessionOverride: () => useCogsetSessionStore.getState().overrideCogsetId,
    clearSessionOverride: () => useCogsetSessionStore.getState().clearOverride(),
    subscribeSession: (listener) =>
      useCogsetSessionStore.subscribe((next, previous) => {
        if (next.overrideCogsetId !== previous.overrideCogsetId) listener()
      }),
    getWorkspace: workspace,
    subscribeWorkspace: (listener) => {
      let last = workspace()
      return useProjectStore.subscribe(() => {
        const next = workspace()
        if (next.workspaceId === last.workspaceId && next.cogsetId === last.cogsetId) return
        last = next
        listener()
      })
    },
    getState: cogsets.getCogsetState,
    subscribeState: (listener) => {
      let first = true
      const subscription = liveQuery(() => getDb().pluginCogsetState.toArray()).subscribe({
        next: () => {
          // The initial emission is the state `startCogsetFollower` already read.
          if (first) {
            first = false
            return
          }
          listener()
        },
        error: (error) =>
          loggers.plugin.warn("cogset state subscription failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
      })
      return () => subscription.unsubscribe()
    },
    updateState: (patch) => cogsets.updateCogsetState(patch),
    cogsetExists: async (id) => !!(await cogsets.getCogset(id)),
    runsInFlight: () => broker.list().length > 0,
    subscribeRuns: (listener) => broker.subscribe(listener),
    activate: (cogsetId) => reconcile.activateCogset(cogsetId),
    activationTarget: reconcile.cogsetActivationTarget,
    now: Date.now,
  })
  setActiveCogsetFollower(follower)
  return {
    evaluate: follower.evaluate,
    stop: () => {
      follower.stop()
      setActiveCogsetFollower(null)
    },
  }
}
