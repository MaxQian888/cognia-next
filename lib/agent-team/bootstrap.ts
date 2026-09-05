/**
 * The ordered Squad bootstrap (ADR-0169).
 *
 * One runtime means one boot sequence, and the order is the contract:
 *
 *   1. hydrate       Squad definitions come out of the account database and
 *                    are migrated onto the current definition contract.
 *   2. adapters      The runtime deps, the review gate and the control plane
 *                    are installed. From here `startSquadRun` can dispatch.
 *   3. import        Legacy run history is copied into the canonical records.
 *   4. recover       Pending interrupts are reconciled, then every durable run
 *                    that was live when the process died is recovered.
 *   5. ready         The readiness signal flips. Launch seams wait on it.
 *
 * Recovery before hydration would resume runs over definitions that are still
 * arriving. Dispatch before adapters would throw "runtime not configured" at
 * the first click. History import after recovery would let a legacy row that
 * became `recovery_required` miss the recovery pass that surfaces it. Each
 * stage therefore awaits the one before it, and a launch that arrives early
 * is refused with `runtime_not_ready` rather than raced.
 *
 * The bootstrap is keyed on the unlocked account: switching accounts disposes
 * it and starts a new one against the database that is selected now.
 *
 * Every collaborator is injectable so the sequence is testable without the
 * Agent-Team graph. Defaults are dynamic imports for the same reason.
 */

import {
  setAgentTeamBindingCandidateResolver,
  startAgentTeamDexieBridge,
  whenAgentTeamDexieBridgeHydrated,
} from "@/stores/agent/agent-team-store/dexie-bridge"
import type { SquadBindingCandidates } from "./definition-contract"
import type { LegacyRunBackfillOutcome } from "./legacy-run-history"

export type SquadBootstrapStage = "hydrate" | "adapters" | "import_history" | "recover" | "ready"

export type SquadRuntimeState = "idle" | "starting" | "ready" | "failed"

export interface SquadBootstrapOutcome {
  ok: boolean
  /** The stage that failed, when `ok` is false. */
  failedStage?: SquadBootstrapStage
  history?: LegacyRunBackfillOutcome
  recovered?: Array<{ runId: string; status: "recovering" | "needs_input" }>
  recoveries?: { armed: number; alreadyPending: number }
  durationMs: number
}

export interface SquadBootstrapDeps {
  /** Starts the Dexie mirror. Returns its disposer. */
  startBridge?: () => () => void
  /** Settles when the mirror's hydration and definition migration are done. */
  whenHydrated?: () => Promise<void>
  setCandidateResolver?: (
    resolver: ((projectId: string | undefined) => Promise<SquadBindingCandidates>) | undefined
  ) => void
  resolveCandidates?: (projectId: string | undefined) => Promise<SquadBindingCandidates>
  /** Installs the runtime deps (`configureAgentTeamRuntime(buildAgentTeamRuntimeDeps())`). */
  installAdapters?: () => Promise<void> | void
  backfillHistory?: (now: number) => Promise<LegacyRunBackfillOutcome>
  recoverInterrupts?: (now: number) => Promise<void>
  recoverRuns?: () => Promise<Array<{ runId: string; status: "recovering" | "needs_input" }>>
  /** Re-raise the `team_recovery` interrupt of every parked run that lacks one. */
  armRecoveries?: () => Promise<{ armed: number; alreadyPending: number }>
  onStage?: (stage: SquadBootstrapStage) => void
  now?: () => number
}

export interface SquadBootstrapHandle {
  done: Promise<SquadBootstrapOutcome>
  /** Stops the mirror and returns the runtime to `idle`. */
  dispose: () => void
}

let state: SquadRuntimeState = "idle"
let generation = 0
/**
 * The one bridge this process runs. The bridge module is a singleton that
 * answers "already started" with a no-op disposer, so two bootstraps racing
 * through an awaited import could start one bridge and then dispose it from
 * the run that lost (React Strict Mode mounts an effect twice, an account
 * switch mounts a new run before the old one has finished starting). Holding
 * the disposer here and starting the bridge SYNCHRONOUSLY at the top of a run
 * removes the window: the previous bridge is gone before the next one starts.
 */
let activeBridgeDisposer: (() => void) | undefined
let readySignal: { promise: Promise<boolean>; resolve: (ready: boolean) => void } = signal()

function signal() {
  let resolve!: (ready: boolean) => void
  const promise = new Promise<boolean>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

export function getSquadRuntimeState(): SquadRuntimeState {
  return state
}

/**
 * Whether a launch may dispatch now.
 *
 * `idle` counts as ready: a process that never ran the bootstrap (the CLI, a
 * headless host, a unit test) owns its own configuration and must not be
 * refused by a signal nothing will ever flip.
 */
export function isSquadRuntimeReady(): boolean {
  return state === "ready" || state === "idle"
}

/**
 * Resolves `true` once the runtime can dispatch, `false` when the bootstrap
 * failed or did not finish within `timeoutMs`. Never throws.
 */
export function awaitSquadRuntimeReady(timeoutMs = 15_000): Promise<boolean> {
  if (isSquadRuntimeReady()) return Promise.resolve(true)
  if (state === "failed") return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void readySignal.promise.then((ready) => {
      clearTimeout(timer)
      resolve(ready)
    })
  })
}

export function __resetSquadBootstrapForTesting(): void {
  state = "idle"
  generation += 1
  readySignal = signal()
  activeBridgeDisposer?.()
  activeBridgeDisposer = undefined
}

async function defaultWhenHydrated(): Promise<void> {
  await whenAgentTeamDexieBridgeHydrated()
}

async function defaultResolveCandidates(
  projectId: string | undefined
): Promise<SquadBindingCandidates> {
  if (!projectId) return {}
  const [{ resolveSquadBindingCandidates }, { getDb }] = await Promise.all([
    import("./binding-candidates"),
    import("@/lib/db/schema"),
  ])
  const project = await getDb().projects.get(projectId)
  return resolveSquadBindingCandidates(project)
}

async function defaultInstallAdapters(): Promise<void> {
  const [{ configureAgentTeamRuntime }, { buildAgentTeamRuntimeDeps }] = await Promise.all([
    import("@/lib/ai/agent/team/squad-lifecycle-runner"),
    import("@/lib/ai/agent/agent-team-runtime-deps"),
  ])
  configureAgentTeamRuntime(buildAgentTeamRuntimeDeps())
}

async function defaultBackfillHistory(now: number): Promise<LegacyRunBackfillOutcome> {
  const { backfillLegacyTeamRunHistory } = await import("./legacy-run-history")
  return backfillLegacyTeamRunHistory(now)
}

async function defaultRecoverInterrupts(now: number): Promise<void> {
  const { recoverPendingRunInterrupts } = await import("@/lib/execution/run-control")
  await recoverPendingRunInterrupts(now)
}

async function defaultRecoverRuns() {
  const { recoverDurableAgentTeams } = await import("@/lib/ai/agent/agent-team")
  return recoverDurableAgentTeams()
}

async function defaultArmRecoveries() {
  const { armPendingTeamRecoveries } = await import("@/lib/ai/agent/team/team-recovery")
  return armPendingTeamRecoveries()
}

/**
 * Run the bootstrap. Calling it again disposes the previous run first, so the
 * account-keyed initializer can simply call it on every key change.
 */
export function runSquadBootstrap(deps: SquadBootstrapDeps = {}): SquadBootstrapHandle {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const myGeneration = ++generation
  const stale = () => myGeneration !== generation
  state = "starting"
  readySignal = signal()
  const mySignal = readySignal

  const stage = (s: SquadBootstrapStage) => deps.onStage?.(s)

  // Synchronous, before any await: the previous bridge is disposed and the new
  // one started in the same turn, so no other run can observe a half state.
  stage("hydrate")
  activeBridgeDisposer?.()
  activeBridgeDisposer = undefined
  ;(deps.setCandidateResolver ?? setAgentTeamBindingCandidateResolver)(
    deps.resolveCandidates ?? defaultResolveCandidates
  )
  const disposeBridge: () => void = (deps.startBridge ?? startAgentTeamDexieBridge)()
  activeBridgeDisposer = disposeBridge

  const finish = (outcome: Omit<SquadBootstrapOutcome, "durationMs">): SquadBootstrapOutcome => {
    if (!stale()) {
      state = outcome.ok ? "ready" : "failed"
      mySignal.resolve(outcome.ok)
    }
    return { ...outcome, durationMs: now() - startedAt }
  }

  const done = (async (): Promise<SquadBootstrapOutcome> => {
    let current: SquadBootstrapStage = "hydrate"
    try {
      await (deps.whenHydrated ?? defaultWhenHydrated)()
      if (stale()) return finish({ ok: false, failedStage: current })

      current = "adapters"
      stage("adapters")
      await (deps.installAdapters ?? defaultInstallAdapters)()
      if (stale()) return finish({ ok: false, failedStage: current })

      current = "import_history"
      stage("import_history")
      const history = await (deps.backfillHistory ?? defaultBackfillHistory)(now())
      if (stale()) return finish({ ok: false, failedStage: current, history })

      current = "recover"
      stage("recover")
      await (deps.recoverInterrupts ?? defaultRecoverInterrupts)(now())
      const recovered = await (deps.recoverRuns ?? defaultRecoverRuns)()
      if (stale()) return finish({ ok: false, failedStage: current, history, recovered })
      // After the coordinator's own pass, so a run it just parked is included.
      const recoveries = await (deps.armRecoveries ?? defaultArmRecoveries)()
      if (stale()) return finish({ ok: false, failedStage: current, history, recovered })

      stage("ready")
      return finish({ ok: true, history, recovered, recoveries })
    } catch {
      return finish({ ok: false, failedStage: current })
    }
  })()

  return {
    done,
    dispose: () => {
      if (activeBridgeDisposer === disposeBridge) activeBridgeDisposer = undefined
      disposeBridge()
      if (!stale()) {
        generation += 1
        state = "idle"
        mySignal.resolve(false)
        readySignal = signal()
      }
    },
  }
}
