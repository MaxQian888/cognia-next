import { liveQuery } from "dexie"
import {
  deterministicScorers,
  SCORING_VERSION,
  type EvalProject,
  type EvalExperimentState,
  type EvalReportView,
} from "@cognia/eval-core"
import type { AppSettings } from "@cognia/agent-config-types"
import { APP_VERSION } from "@/lib/app-version"
import { getDb } from "@/lib/db/schema"
import { recoverInterruptedEvalWork, type EvalPersistenceScope } from "@/lib/db/eval-lab"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
  type RuntimeTargetScope,
} from "@/lib/runtime/runtime-target-context"
import { registerRuntimeTargetCleanup } from "@/lib/runtime/runtime-target-lifecycle"
import { acquireExclusiveWebLock } from "@/lib/runtime/exclusive-web-lock"
import { useAccountStore } from "@/stores/account/account-store"
import { loadOrCreateEvalArtifactKey, decryptEvalArtifact } from "./artifact-crypto"
import { createBrowserEvalOrchestrator, type EvalExecutedTaskArtifacts } from "./browser-execution"
import type { DurableEvalOrchestrator } from "./orchestrator"
import { EvalProjectService } from "./project-service"
import { checkEvalEnvironmentCompatibility } from "./environment-preflight"
import { loadEvalAppSettings } from "./runtime-context"
import { loadEvalReportView } from "./report-view"
import { recoverEvalQueueOnStartup } from "./recovery"
import { createEvalReviewService, type EvalReviewService } from "./review-service"

export class EvalRuntimeScopeError extends Error {
  readonly code = "EVAL_RUNTIME_SCOPE_CHANGED"
  constructor() {
    super("Evaluation runtime scope is no longer active")
    this.name = "EvalRuntimeScopeError"
  }
}

export interface EvalExecutionStatus {
  experimentId: string
  state: EvalExperimentState
  total: number
  completed: number
  spentCost: number
  reservedCost: number
  budgetCap: number
  error?: string
}

type Engine = DurableEvalOrchestrator<EvalExecutedTaskArtifacts>
export interface EvalExecutionRuntimeOptions {
  scope: RuntimeTargetScope
  db: ReturnType<typeof getDb>
  assertActive(): void
  loadKey?: typeof loadOrCreateEvalArtifactKey
  loadSettings?: () => Promise<AppSettings | null>
  createOrchestrator?: typeof createBrowserEvalOrchestrator
  checkEnvironment?: typeof checkEvalEnvironmentCompatibility
  acquireLock?: typeof acquireExclusiveWebLock
}

/** One scope-bound owner of the existing durable engine, independent of UI lifetime. */
export class EvalExecutionRuntime {
  private disposed = false
  private key?: Uint8Array
  private keyPromise?: Promise<Uint8Array>
  private reviewPromise?: Promise<EvalReviewService>
  private readonly engines = new Map<string, Engine>()
  private readonly runs = new Map<string, Promise<void>>()
  private readonly starts = new Map<string, Promise<string>>()
  private readonly resumes = new Map<string, Promise<void>>()
  private readonly errors = new Map<string, string>()
  private readonly observers = new Set<{
    id: string
    next(status: EvalExecutionStatus): void
    stop(): void
    error(error: Error): void
  }>()
  private ownership?: { controller: AbortController; acquired: Promise<boolean> }
  private controls = 0
  private recovery?: Promise<Array<{ experimentId: string; state: EvalExperimentState }>>
  private readonly persistence: EvalPersistenceScope
  private readonly projectService: EvalProjectService

  constructor(private readonly options: EvalExecutionRuntimeOptions) {
    this.persistence = { db: options.db, assertActive: () => this.assertActive() }
    this.projectService = new EvalProjectService({
      scope: this.persistence,
      checkEnvironment: options.checkEnvironment,
    })
  }

  assertActive(): void {
    if (this.disposed) throw new EvalRuntimeScopeError()
    this.options.assertActive()
  }

  private async artifactKey(): Promise<Uint8Array> {
    this.assertActive()
    if (!this.keyPromise) {
      this.keyPromise = (this.options.loadKey ?? loadOrCreateEvalArtifactKey)(
        this.options.scope.accountId
      )
        .then((key) => {
          const owned = key.slice()
          try {
            this.assertActive()
          } catch (error) {
            owned.fill(0)
            throw error
          }
          this.key = owned
          return owned
        })
        .catch((error) => {
          this.keyPromise = undefined
          throw error
        })
    }
    const key = await this.keyPromise
    this.assertActive()
    return key
  }

  private async own(): Promise<boolean> {
    this.assertActive()
    if (!this.ownership) {
      const controller = new AbortController()
      const acquired = (this.options.acquireLock ?? acquireExclusiveWebLock)(
        `cognia:eval:${this.options.db.name}`,
        controller.signal,
        { required: true, ifAvailable: true }
      )
      this.ownership = { controller, acquired }
    }
    try {
      const acquired = await this.ownership.acquired
      this.assertActive()
      if (!acquired) {
        this.ownership?.controller.abort()
        this.ownership = undefined
      }
      return acquired
    } catch (error) {
      this.ownership?.controller.abort()
      this.ownership = undefined
      throw error
    }
  }

  private releaseIdleOwnership(): void {
    if (this.controls || this.runs.size) return
    this.ownership?.controller.abort()
    this.ownership = undefined
  }

  private async createEngine(): Promise<Engine> {
    const [artifactKey, appSettings] = await Promise.all([
      this.artifactKey(),
      (this.options.loadSettings ?? loadEvalAppSettings)(),
    ])
    this.assertActive()
    if (!appSettings) throw new Error("Evaluation settings are unavailable")
    return (this.options.createOrchestrator ?? createBrowserEvalOrchestrator)({
      artifactKey,
      appSettings,
      scope: this.persistence,
    })
  }

  private launch(id: string, engine: Engine): void {
    this.assertActive()
    if (this.runs.has(id)) return
    this.engines.set(id, engine)
    this.errors.delete(id)
    let cancelled = false
    const stop = this.subscribe(
      id,
      (status) => {
        if (status.state === "cancelled" && !cancelled) {
          cancelled = true
          void engine.cancel(id).catch(() => {})
        }
      },
      () => {
        if (!this.disposed) engine.interrupt()
      }
    )
    const running = engine
      .run(id)
      .catch((error: unknown) => {
        if (!this.disposed) {
          this.errors.set(id, error instanceof Error ? error.message : String(error))
          void this.status(id)
            .then((status) => {
              for (const observer of this.observers) {
                if (observer.id === id) observer.next(status)
              }
            })
            .catch(() => {})
        }
      })
      .finally(() => {
        stop()
        this.runs.delete(id)
        this.engines.delete(id)
        this.releaseIdleOwnership()
      })
    this.runs.set(id, running)
  }

  start(project: EvalProject): Promise<string> {
    this.assertActive()
    const existing = this.starts.get(project.id)
    if (existing) return existing
    const starting = this.startOnce(project).finally(() => this.starts.delete(project.id))
    this.starts.set(project.id, starting)
    return starting
  }

  private async startOnce(project: EvalProject): Promise<string> {
    this.controls++
    try {
      if (!(await this.own())) throw new Error("Another window owns evaluation execution")
      const engine = await this.createEngine()
      const environment = await (
        this.options.checkEnvironment ?? checkEvalEnvironmentCompatibility
      )(project)
      this.assertActive()
      await this.options.db.evalProjects.put({ ...project, updatedAt: Date.now() })
      this.assertActive()
      const active = await this.options.db.evalExperiments
        .where("projectId")
        .equals(project.id)
        .filter((row) => ["queued", "running", "paused"].includes(row.state))
        .first()
      this.assertActive()
      if (active) {
        if (!this.runs.has(active.id)) {
          if (active.state === "running")
            await recoverInterruptedEvalWork(active.id, this.persistence)
          const current = await this.options.db.evalExperiments.get(active.id)
          this.assertActive()
          if (current?.state === "queued") this.launch(active.id, engine)
        }
        return active.id
      }
      const experiment = await this.projectService.start(project.id, {
        appVersion: APP_VERSION,
        scorerVersions: Object.fromEntries(
          deterministicScorers().map((scorer) => [scorer.id, String(SCORING_VERSION)])
        ),
        randomSeed: crypto.getRandomValues(new Uint32Array(1))[0],
        environmentCompatibility: environment,
      })
      this.assertActive()
      this.launch(experiment.id, engine)
      return experiment.id
    } finally {
      this.controls--
      this.releaseIdleOwnership()
    }
  }

  resume(id: string): Promise<void> {
    this.assertActive()
    const existing = this.resumes.get(id)
    if (existing) return existing
    const resuming = this.resumeOnce(id).finally(() => this.resumes.delete(id))
    this.resumes.set(id, resuming)
    return resuming
  }

  private async resumeOnce(id: string): Promise<void> {
    const currentRun = this.runs.get(id)
    if (currentRun) {
      await this.projectService.resume(id)
      this.assertActive()
      // A loop may already have observed pause before resume persisted queued.
      // Once that loop exits, restart only if work still needs a runner.
      void currentRun
        .then(async () => {
          this.assertActive()
          const experiment = await this.options.db.evalExperiments.get(id)
          this.assertActive()
          if (experiment?.state === "queued") await this.resume(id)
        })
        .catch(() => {})
      return
    }
    this.controls++
    try {
      if (!(await this.own())) throw new Error("Another window owns evaluation execution")
      const engine = await this.createEngine()
      this.assertActive()
      const experiment = await this.options.db.evalExperiments.get(id)
      this.assertActive()
      if (!experiment) throw new Error(`Evaluation experiment ${id} not found`)
      if (["completed", "cancelled", "failed"].includes(experiment.state)) return
      if (experiment.state === "running") await recoverInterruptedEvalWork(id, this.persistence)
      this.assertActive()
      await this.projectService.resume(id)
      this.assertActive()
      this.launch(id, engine)
    } finally {
      this.controls--
      this.releaseIdleOwnership()
    }
  }

  async pause(id: string): Promise<void> {
    this.assertActive()
    await this.projectService.pause(id)
    this.assertActive()
  }
  async cancel(id: string): Promise<void> {
    this.assertActive()
    const engine = this.engines.get(id)
    const cancel = engine?.cancel(id)
    await this.projectService.cancel(id)
    await cancel
    this.assertActive()
  }
  async extendBudget(id: string, cap: number): Promise<void> {
    this.assertActive()
    await this.projectService.extendBudget(id, cap)
    this.assertActive()
  }

  async status(id: string): Promise<EvalExecutionStatus> {
    this.assertActive()
    const { experiment, tasks } = await this.projectService.status(id)
    this.assertActive()
    return {
      experimentId: id,
      state: experiment.state,
      total: Object.values(tasks).reduce((sum, n) => sum + (n ?? 0), 0),
      completed: tasks.completed ?? 0,
      spentCost: experiment.spentCost,
      reservedCost: experiment.reservedCost,
      budgetCap: experiment.budgetCap ?? experiment.manifest.budget.hardCap,
      error: this.errors.get(id) ?? experiment.failure,
    }
  }

  subscribe(
    id: string,
    listener: (status: EvalExecutionStatus) => void,
    onError: (error: Error) => void = () => {}
  ): () => void {
    this.assertActive()
    const subscription = liveQuery(() => this.status(id)).subscribe({
      next: (status) => {
        if (!this.disposed) listener(status)
      },
      error: (error: unknown) => onError(error instanceof Error ? error : new Error(String(error))),
    })
    const observer = { id, next: listener, stop: () => subscription.unsubscribe(), error: onError }
    this.observers.add(observer)
    return () => {
      observer.stop()
      this.observers.delete(observer)
    }
  }

  async report(id: string): Promise<EvalReportView> {
    const key = await this.artifactKey()
    this.assertActive()
    const db = this.options.db
    const report = await loadEvalReportView(id, key, {
      loadExperiment: (id) => db.evalExperiments.get(id),
      loadTasks: (id) => db.evalTasks.where("experimentId").equals(id).toArray(),
      loadSamples: (id) => db.evalSamples.where("experimentId").equals(id).toArray(),
      loadScores: (id) => db.evalScores.where("experimentId").equals(id).toArray(),
      loadRecommendations: (id) =>
        db.evalRecommendations.where("experimentId").equals(id).toArray(),
      decryptArtifact: async <T>(
        key: Uint8Array,
        envelope: Parameters<typeof decryptEvalArtifact>[1]
      ) => {
        this.assertActive()
        const result = await decryptEvalArtifact<T>(key, envelope)
        this.assertActive()
        return result
      },
    })
    this.assertActive()
    return report
  }

  async getReviewService(): Promise<EvalReviewService> {
    this.assertActive()
    if (!this.reviewPromise)
      this.reviewPromise = this.artifactKey()
        .then((artifactKey) => {
          this.assertActive()
          return createEvalReviewService({
            artifactKey,
            assertActive: () => this.assertActive(),
            db: this.options.db,
          })
        })
        .catch((error) => {
          this.reviewPromise = undefined
          throw error
        })
    const service = await this.reviewPromise
    this.assertActive()
    return service
  }

  recover(): Promise<Array<{ experimentId: string; state: EvalExperimentState }>> {
    this.assertActive()
    if (!this.recovery)
      this.recovery = this.recoverOnce().finally(() => {
        this.recovery = undefined
      })
    return this.recovery
  }

  private async recoverOnce() {
    this.controls++
    try {
      const candidates = await this.options.db.evalExperiments
        .filter((row) => ["queued", "running", "paused", "interrupted"].includes(row.state))
        .toArray()
      this.assertActive()
      // Observers remain useful while another window owns the live queue.
      const owned = await this.own().catch((error) => {
        this.assertActive()
        if (!this.options.acquireLock && !globalThis.navigator?.locks?.request) return false
        throw error
      })
      if (!owned)
        return candidates
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((row) => ({ experimentId: row.id, state: row.state }))
      const current = await this.options.db.evalExperiments
        .filter((row) => ["queued", "running", "paused", "interrupted"].includes(row.state))
        .toArray()
      this.assertActive()
      const recovered = await recoverEvalQueueOnStartup({
        listCandidates: async () => current.filter((row) => !this.runs.has(row.id)),
        recover: (id) => recoverInterruptedEvalWork(id, this.persistence),
      })
      const recoveredStates = new Map(recovered.map((row) => [row.experimentId, row.state]))
      return current
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((row) => ({
          experimentId: row.id,
          state: recoveredStates.get(row.id) ?? row.state,
        }))
    } finally {
      this.controls--
      this.releaseIdleOwnership()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const engine of this.engines.values()) engine.interrupt()
    this.ownership?.controller.abort()
    this.ownership = undefined
    this.key?.fill(0)
    this.key = undefined
    for (const observer of this.observers) {
      observer.stop()
      try {
        observer.error(new EvalRuntimeScopeError())
      } catch {
        /* All observers must be disposed. */
      }
    }
    this.observers.clear()
  }
}

let activeRuntime:
  | {
      runtime: EvalExecutionRuntime
      scope: RuntimeTargetScope
      db: ReturnType<typeof getDb>
      revision: number
      stop(): void
    }
  | undefined

/** UI unmount only unsubscribes; account/target lifecycle owns execution disposal. */
export function getEvalExecutionRuntime(): EvalExecutionRuntime {
  const scope = getActiveRuntimeTargetContext()
  const account = useAccountStore.getState()
  if (!scope || account.locked || account.unlockedAccountId !== scope.accountId)
    throw new EvalRuntimeScopeError()
  const db = getDb()
  const revision = account.accountRevision
  const matches = () => {
    try {
      const current = getActiveRuntimeTargetContext()
      const account = useAccountStore.getState()
      return (
        current?.accountId === scope.accountId &&
        current.targetId === scope.targetId &&
        current.routingGeneration === scope.routingGeneration &&
        !account.locked &&
        account.unlockedAccountId === scope.accountId &&
        account.accountRevision === revision &&
        getDb() === db
      )
    } catch {
      // A target transition can temporarily make the database unavailable.
      return false
    }
  }
  if (
    activeRuntime &&
    activeRuntime.db === db &&
    activeRuntime.revision === revision &&
    JSON.stringify(activeRuntime.scope) === JSON.stringify(scope)
  )
    return activeRuntime.runtime
  activeRuntime?.stop()
  const runtime = new EvalExecutionRuntime({
    scope,
    db,
    assertActive: () => {
      if (!matches()) throw new EvalRuntimeScopeError()
    },
  })
  const stop = () => {
    runtime.dispose()
    unregisterCleanup()
    unsubscribeContext()
    unsubscribeAccount()
    if (activeRuntime?.runtime === runtime) activeRuntime = undefined
  }
  const unregisterCleanup = registerRuntimeTargetCleanup(stop)
  const unsubscribeContext = subscribeRuntimeTargetContext(() => {
    if (!matches()) stop()
  })
  const unsubscribeAccount = useAccountStore.subscribe(() => {
    if (!matches()) stop()
  })
  activeRuntime = { runtime, scope, db, revision, stop }
  return runtime
}
