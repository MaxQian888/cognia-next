/**
 * The durable Agent Team coordinator (ADR-0217): run preparation, child
 * registration, fair admission, writer leases, steering, checkpoints,
 * recovery, retry and operator control (pause, resume, sleep, wake,
 * terminate, manual takeover).
 *
 * Host-independent. Run state goes through the {@link TeamRunStore}; the
 * host supplies its run journal, its PII redaction, its path semantics and
 * its remote-session projection as ports.
 */

import { createDecisionLedger } from "./decision-ledger"
import { createEvidenceBundle } from "./evidence"
import { createFairTeamScheduler } from "./fair-scheduler"
import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamRepositoryBinding,
  AgentTeamResourcePolicy,
  AgentTeamRunStatus,
  AgentTeamSideEffect,
  AgentTeamSteeringReceipt,
  AgentTeamTrajectoryEvent,
  AgentTeamWriteMode,
} from "./records"
import { CHILD_ADMISSION_WAITING_REASON, isChildReplaySafe } from "./replay"
import type { TeamRunStore } from "./store"

export interface DurableChildControl {
  /** Must route through the runtime's PII-gated steering adapter. */
  steer(message: string, sourceMessageId: string): Promise<void>
  pause?(): Promise<boolean | void>
  resume?(): Promise<void>
  terminate?(): Promise<void>
}

/**
 * The team a durable run executes, as the coordinator needs it. Hosts map
 * their own team configuration onto this; nothing else of it is read.
 */
export interface DurableTeamSpec {
  id: string
  leadId: string
  projectId?: string
  /** The run's objective; also its title in the host's run journal. */
  objective: string
  /** Repository bindings; exactly one must be primary. */
  repositories?: readonly AgentTeamRepositoryBinding[]
  /** Fallback single writable primary repository when none are bound. */
  workingDir?: string
  writeMode?: AgentTeamWriteMode
  resourcePolicy?: AgentTeamResourcePolicy
  /** Per-team child concurrency when no resource policy is given. */
  maxConcurrentTeammates?: number
  environmentVersionId?: string
  /** Recorded as immutable user constraints when the run is created. */
  userConstraints?: readonly { title: string; detail: string }[]
}

/** The host's record of runs it executes (its run list, cockpit, history). */
export interface TeamRunJournal {
  /**
   * Called each time a run is prepared: record the run when it is new, note a
   * resumption when the host had it waiting. Must be idempotent per run.
   */
  runPrepared(input: {
    runId: string
    projectId?: string
    title: string
    at: number
  }): Promise<void>
}

/** Host path semantics (drive letters, UNC, case folding) for ownership checks. */
export interface TeamPathPolicy {
  /** Normalized absolute form, or `""` when the path cannot be resolved. */
  normalize(path: string): string
  isWithinRoot(target: string, root: string): boolean
}

/** The host's handle on sessions a remote child ran in. */
export interface TeamRemoteSessions {
  /** Release a terminated remote child's session from the host's projection. */
  release(remoteSessionId: string): Promise<void>
}

export interface DurableTeamCoordinatorOptions<TConstraints = unknown> {
  /** Where run state lives. */
  store: TeamRunStore<TConstraints>
  journal: TeamRunJournal
  /**
   * Redact text the coordinator persists (steering messages, manual takeover
   * commands and diffs); `undefined` when it would still leak, which refuses
   * the write. Required: no coordinator persists unchecked text.
   */
  redactForPersistence: (text: string) => string | undefined
  paths: TeamPathPolicy
  remoteSessions: TeamRemoteSessions
  now?: () => number
  globalConcurrency?: number
  agingIntervalMs?: number
}

export interface RegisterDurableChildInput {
  runId: string
  childRunId: string
  teammateId: string
  taskId: string
  repositoryId: string
  access: "read" | "write"
  runtime?: string
  sessionId?: string
  workspacePath?: string
  branch?: string
  fileOwnership?: string[]
}

export interface WorkspaceLeaseRequest {
  runId: string
  repositoryId: string
  access: "read" | "write"
  fileOwnership?: string[]
  childRunId?: string
}

export interface RecoveryOutcome {
  runId: string
  status: Extract<AgentTeamRunStatus, "recovering" | "needs_input">
}

interface RunPolicy {
  teamId: string
  writeMode: AgentTeamWriteMode
  repositories: Map<string, AgentTeamRepositoryBinding>
  resourcePolicy: AgentTeamResourcePolicy
}

interface ActiveOwnership {
  leaseId: string
  paths: string[]
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "terminated"])
/**
 * Whether a child may be replayed from its checkpoint (the rule:
 * `isChildReplaySafe`), reading the latest checkpoint and the run's
 * trajectory from `store` when the caller has not already loaded them.
 */
export async function isStoredChildReplaySafe(
  store: TeamRunStore<unknown>,
  childRunId: string,
  checkpoint?: AgentTeamCheckpoint,
  trajectory?: readonly AgentTeamTrajectoryEvent[]
): Promise<boolean> {
  const candidate = checkpoint ?? (await store.getLatestCheckpoint(childRunId))
  if (!candidate) return false
  const events = trajectory ?? (await store.listTrajectory(candidate.runId))
  return isChildReplaySafe(childRunId, candidate, events)
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

const EMPTY_USAGE: AgentTeamChildRun["resourceUsage"] = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  wallTimeMs: 0,
  toolTimeMs: 0,
  attempts: 1,
  failures: 0,
}

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function normalizeRepositories(team: DurableTeamSpec): Map<string, AgentTeamRepositoryBinding> {
  const configured = team.repositories
  const repositories: readonly AgentTeamRepositoryBinding[] =
    configured && configured.length > 0
      ? configured
      : team.workingDir
        ? [{ id: "primary", role: "primary", path: team.workingDir, writable: true }]
        : []
  const primary = repositories.filter((repo) => repo.role === "primary")
  if (primary.length !== 1) {
    throw new Error("Durable AgentTeam requires exactly one primary repository")
  }
  const ids = new Set<string>()
  for (const repository of repositories) {
    if (!repository.id || !repository.path) {
      throw new Error("Durable AgentTeam repository bindings require id and path")
    }
    if (ids.has(repository.id)) throw new Error(`Duplicate repository id: ${repository.id}`)
    ids.add(repository.id)
    for (const dependency of repository.dependsOn ?? []) {
      if (dependency === repository.id) {
        throw new Error(`Repository ${repository.id} cannot depend on itself`)
      }
    }
  }
  for (const repository of repositories) {
    for (const dependency of repository.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`Unknown repository dependency: ${dependency}`)
    }
  }
  return new Map(repositories.map((repository) => [repository.id, repository]))
}

function overlaps(paths: TeamPathPolicy, a: string[], b: string[]): boolean {
  return a.some((left) =>
    b.some((right) => paths.isWithinRoot(left, right) || paths.isWithinRoot(right, left))
  )
}

/**
 * Deep module for durable child control. The store is the source of truth;
 * the maps below hold process-local provider handles, writer locks and
 * scheduler state only, so another process recovers from the store alone.
 */
export function createDurableTeamCoordinator<TConstraints = unknown>(
  options: DurableTeamCoordinatorOptions<TConstraints>
) {
  const { store, journal, paths, remoteSessions } = options
  const now = options.now ?? Date.now
  const persistable = (text: string, refusal: string): string => {
    const redacted = options.redactForPersistence(text)
    if (redacted === undefined) throw new Error(refusal)
    return redacted
  }
  const policies = new Map<string, RunPolicy>()
  const controls = new Map<string, DurableChildControl>()
  const writerTails = new Map<string, Promise<void>>()
  const activeOwnership = new Map<string, ActiveOwnership[]>()
  const scheduler = createFairTeamScheduler({
    globalConcurrency: options.globalConcurrency ?? 8,
    agingIntervalMs: options.agingIntervalMs ?? 30_000,
  })
  const admissionWaiters = new Map<string, () => void>()
  const pausedRuns = new Set<string>()
  const runResumeWaiters = new Map<string, Set<() => void>>()
  const admissions = new Map<string, { controller: AbortController; runId?: string }>()
  const pendingWakes = new Map<string, Promise<void>>()

  const assertRunnable = async (childRunId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (TERMINAL_STATUSES.has(child.status)) {
      throw new Error(`Durable child ${childRunId} is terminal: ${child.status}`)
    }
    if (["pausing", "paused", "sleeping", "needs_input"].includes(child.status)) {
      throw new Error(
        `Durable child ${childRunId} is not accepting new turns while ${child.status}`
      )
    }
    const run = await store.getRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)
    if (TERMINAL_STATUSES.has(run.status) || run.status === "needs_input") {
      throw new Error(
        `Durable AgentTeam run ${run.id} is not accepting new turns while ${run.status}`
      )
    }
    signal?.throwIfAborted()
    return { child, run }
  }

  const assertBudget = async (
    childRunId: string,
    run: NonNullable<Awaited<ReturnType<typeof store.getRun>>>
  ) => {
    const resource = policies.get(run.id)?.resourcePolicy
    if (!resource) return
    const usage = run.resourceUsage
    const wallTimeMs = Math.max(0, now() - (run.startedAt ?? run.createdAt))
    if (
      (resource.maxTokens !== undefined && (usage?.totalTokens ?? 0) >= resource.maxTokens) ||
      (resource.maxCostUsd !== undefined && (usage?.costUsd ?? 0) >= resource.maxCostUsd) ||
      (resource.maxWallTimeMs !== undefined && wallTimeMs >= resource.maxWallTimeMs)
    ) {
      const at = now()
      const child = await store.getChild(childRunId)
      const gated = await store.updateRunIfCurrent(
        run.id,
        { status: run.status, updatedAt: run.updatedAt },
        {
          status: "needs_input",
          recoveryReason: "resource_budget_exhausted",
          updatedAt: at,
        }
      )
      if (gated && child && !TERMINAL_STATUSES.has(child.status)) {
        await store.updateChildIfCurrent(childRunId, child, {
          status: "needs_input",
          error: "Resource budget exhausted",
          updatedAt: at,
        })
      }
      throw new Error("Durable AgentTeam resource budget exhausted")
    }
  }

  const pumpAdmissions = (): void => {
    let next = scheduler.acquire(now())
    while (next) {
      admissionWaiters.get(next.id)?.()
      admissionWaiters.delete(next.id)
      next = scheduler.acquire(now())
    }
  }

  const prepareRun = async (team: DurableTeamSpec, runId = newId("team-run")): Promise<string> => {
    const repositories = normalizeRepositories(team)
    const at = now()
    const priority = team.resourcePolicy?.priority ?? 0
    const existing = await store.getRun(runId)
    if (!existing) {
      await store.createRun({
        id: runId,
        teamId: team.id,
        ...(team.projectId ? { projectId: team.projectId } : {}),
        objective: team.objective,
        status: "running",
        priority,
        decisionVersion: 0,
        ...(team.environmentVersionId ? { environmentVersionId: team.environmentVersionId } : {}),
        resourceUsage: { ...EMPTY_USAGE, attempts: 0 },
        createdAt: at,
        startedAt: at,
        updatedAt: at,
      })
      const ledger = createDecisionLedger({ store, runId, leadId: team.leadId, now })
      for (const constraint of team.userConstraints ?? []) {
        await ledger.addUserConstraint(constraint)
      }
    } else if (existing.teamId !== team.id) {
      throw new Error(`Durable run ${runId} belongs to another team`)
    } else if (existing.status === "queued") {
      // A host may journal the run as `queued` before dispatch; admission is
      // what moves it to `running`.
      const started = await store.updateRunIfCurrent(runId, existing, {
        status: "running",
        startedAt: at,
        updatedAt: at,
      })
      if (!started) throw new Error(`Durable AgentTeam run ${runId} changed before preparation`)
    }
    await journal.runPrepared({
      runId,
      ...(team.projectId ? { projectId: team.projectId } : {}),
      // The objective, not a constant: on a run with no conversation this may
      // be the only thing the host's run list can say about it.
      title: team.objective || "Agent team run",
      at,
    })
    policies.set(runId, {
      teamId: team.id,
      writeMode: team.writeMode ?? "single-writer",
      repositories,
      resourcePolicy: team.resourcePolicy ?? {
        priority,
        maxConcurrentChildren: team.maxConcurrentTeammates ?? 1,
      },
    })
    return runId
  }

  const registerChild = async (
    input: RegisterDurableChildInput,
    via: TeamRunStore<TConstraints> = store
  ): Promise<AgentTeamChildRun> => {
    const run = await via.getRun(input.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${input.runId}`)
    const policy = policies.get(input.runId)
    if (policy && !policy.repositories.has(input.repositoryId)) {
      throw new Error(`Unknown repository for run ${input.runId}: ${input.repositoryId}`)
    }
    if (
      input.access === "write" &&
      policy?.repositories.get(input.repositoryId)?.writable === false
    ) {
      throw new Error(`Repository ${input.repositoryId} is read-only`)
    }
    const at = now()
    const child: AgentTeamChildRun = {
      id: input.childRunId,
      runId: input.runId,
      teamId: run.teamId,
      teammateId: input.teammateId,
      taskId: input.taskId,
      repositoryId: input.repositoryId,
      status: "running",
      attempt: 1,
      decisionVersion: run.decisionVersion,
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.fileOwnership ? { fileOwnership: input.fileOwnership } : {}),
      resourceUsage: { ...EMPTY_USAGE },
      createdAt: at,
      startedAt: at,
      updatedAt: at,
    }
    await via.createChild(child)
    await via.appendTrajectory({
      runId: input.runId,
      childRunId: child.id,
      kind: "child_created",
      correlationId: child.id,
      payload: { access: input.access, repositoryId: input.repositoryId },
      createdAt: at,
    })
    return child
  }

  const withWorkspaceLease = async <T>(
    request: WorkspaceLeaseRequest,
    operation: () => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T> => {
    const execute = async () => {
      signal?.throwIfAborted()
      if (request.childRunId) {
        const { run } = await assertRunnable(request.childRunId, signal)
        if (pausedRuns.has(run.id) || ["pausing", "paused", "sleeping"].includes(run.status)) {
          throw new Error(`Durable AgentTeam run ${run.id} is paused`)
        }
        await assertBudget(request.childRunId, run)
      }
      signal?.throwIfAborted()
      const result = await operation()
      signal?.throwIfAborted()
      return result
    }
    signal?.throwIfAborted()
    if (request.access === "read") return execute()
    const policy = policies.get(request.runId)
    const mode = policy?.writeMode ?? "single-writer"
    const key = `${request.runId}:${request.repositoryId}`

    if (mode === "isolated-parallel") {
      if (!request.fileOwnership || request.fileOwnership.length === 0) {
        throw new Error("Isolated parallel writers require explicit file ownership")
      }
      const repository = policy?.repositories.get(request.repositoryId)
      if (!repository) throw new Error(`Unknown repository: ${request.repositoryId}`)
      const claimed = request.fileOwnership.map((claim) => {
        const path = claim.trim().replace(/\\/g, "/")
        if (!path || path.includes("\0")) throw new Error("Invalid writer ownership path")
        const normalized = paths.normalize(
          /^(?:\/|[A-Za-z]:)/.test(path) ? path : `${repository.path}/${path}`
        )
        if (!normalized || !paths.isWithinRoot(normalized, repository.path)) {
          throw new Error("Writer ownership must remain within its repository")
        }
        return normalized
      })
      const active = activeOwnership.get(key) ?? []
      if (active.some((lease) => overlaps(paths, lease.paths, claimed))) {
        throw new Error("Parallel writer ownership overlaps an active lease")
      }
      const lease: ActiveOwnership = { leaseId: newId("writer"), paths: claimed }
      activeOwnership.set(key, [...active, lease])
      try {
        return await execute()
      } finally {
        const remaining = (activeOwnership.get(key) ?? []).filter(
          (candidate) => candidate.leaseId !== lease.leaseId
        )
        if (remaining.length === 0) activeOwnership.delete(key)
        else activeOwnership.set(key, remaining)
      }
    }

    const previous = writerTails.get(key)
    let release!: () => void
    const own = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous ? previous.then(() => own) : own
    writerTails.set(key, tail)
    try {
      if (previous) await (signal ? waitWithSignal(previous, signal) : previous)
      return await execute()
    } finally {
      release()
      // A cancelled waiter still links later writers to the preceding lease.
      // Removing its tail before that lease settles would let a new writer in.
      void tail.then(() => {
        if (writerTails.get(key) === tail) writerTails.delete(key)
      })
    }
  }

  const withChildAdmission = async <T>(
    childRunId: string,
    operation: (admissionSignal: AbortSignal) => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T> => {
    if (admissions.has(childRunId))
      throw new Error(`Durable child ${childRunId} already has an admission`)
    const admission: { controller: AbortController; runId?: string } = {
      controller: new AbortController(),
    }
    admissions.set(childRunId, admission)
    const admissionSignal = signal
      ? AbortSignal.any([signal, admission.controller.signal])
      : admission.controller.signal
    try {
      let { child, run } = await assertRunnable(childRunId, admissionSignal)
      admission.runId = run.id
      while (pausedRuns.has(run.id) || ["pausing", "paused", "sleeping"].includes(run.status)) {
        let resume!: () => void
        const resumed = new Promise<void>((resolve) => {
          resume = resolve
        })
        const waiters = runResumeWaiters.get(run.id) ?? new Set()
        waiters.add(resume)
        runResumeWaiters.set(run.id, waiters)
        try {
          await waitWithSignal(resumed, admissionSignal)
        } finally {
          waiters.delete(resume)
          if (waiters.size === 0) runResumeWaiters.delete(run.id)
        }
        ;({ child, run } = await assertRunnable(childRunId, admissionSignal))
      }
      await assertBudget(childRunId, run)
      const resource = policies.get(run.id)?.resourcePolicy ?? {
        priority: run.priority,
        maxConcurrentChildren: 1,
      }
      const queued = await store.updateChildIfCurrent(
        childRunId,
        { status: child.status, updatedAt: child.updatedAt },
        { status: "queued", waitingReason: CHILD_ADMISSION_WAITING_REASON, updatedAt: now() }
      )
      if (!queued) throw new Error(`Durable child ${childRunId} changed before admission`)
      admissionSignal.throwIfAborted()
      scheduler.enqueue({
        id: childRunId,
        teamId: child.teamId,
        priority: resource.priority,
        enqueuedAt: now(),
        teamConcurrency: resource.maxConcurrentChildren,
      })
      await waitWithSignal(
        new Promise<void>((resolve) => {
          admissionWaiters.set(childRunId, resolve)
          pumpAdmissions()
        }),
        admissionSignal
      )
      ;({ child, run } = await assertRunnable(childRunId, admissionSignal))
      if (pausedRuns.has(run.id) || ["pausing", "paused", "sleeping"].includes(run.status)) {
        throw new Error(`Durable AgentTeam run ${run.id} is paused`)
      }
      await assertBudget(childRunId, run)
      const started = await store.updateChildIfCurrent(
        childRunId,
        { status: child.status, updatedAt: child.updatedAt },
        { status: "running", waitingReason: undefined, updatedAt: now() }
      )
      if (!started) throw new Error(`Durable child ${childRunId} changed during admission`)
      await assertRunnable(childRunId, admissionSignal)
      const result = await operation(admissionSignal)
      admissionSignal.throwIfAborted()
      return result
    } finally {
      admissions.delete(childRunId)
      admissionWaiters.delete(childRunId)
      scheduler.cancel(childRunId)
      scheduler.release(childRunId)
      pumpAdmissions()
    }
  }

  const attachLiveControl = (childRunId: string, control: DurableChildControl): (() => void) => {
    controls.set(childRunId, control)
    return () => {
      if (controls.get(childRunId) === control) controls.delete(childRunId)
    }
  }

  const steer = async (childRunId: string, message: string): Promise<AgentTeamSteeringReceipt> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const at = now()
    const persistedMessage = persistable(
      message,
      "AgentTeam steering still contains PII after redaction"
    )
    const receipt: AgentTeamSteeringReceipt = {
      id: newId("team-steer"),
      runId: child.runId,
      childRunId,
      message: persistedMessage,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    }
    await store.createSteeringReceipt(receipt)
    await store.appendTrajectory({
      runId: child.runId,
      childRunId,
      kind: "steering_queued",
      correlationId: receipt.id,
      createdAt: at,
    })
    const control = controls.get(childRunId)
    if (!control) return receipt
    try {
      await control.steer(persistedMessage, receipt.id)
      const deliveredAt = now()
      await store.updateSteeringReceipt(receipt.id, "delivered", deliveredAt)
      await store.appendTrajectory({
        runId: child.runId,
        childRunId,
        kind: "steering_delivered",
        correlationId: receipt.id,
        createdAt: deliveredAt,
      })
      return { ...receipt, status: "delivered", deliveredAt, updatedAt: deliveredAt }
    } catch {
      // The durable queued receipt is the deliberate fallback. A subsequent
      // provider turn consumes it at its next safe boundary.
      return receipt
    }
  }

  const checkpoint = async (
    childRunId: string,
    input: {
      trajectorySequence: number
      replay: AgentTeamCheckpoint["replay"]
      sideEffects: AgentTeamSideEffect[]
      workspaceCommit?: string
    }
  ): Promise<AgentTeamCheckpoint> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const run = await store.getRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)
    return store.markCheckpoint({
      runId: child.runId,
      childRunId,
      trajectorySequence: input.trajectorySequence,
      decisionVersion: child.decisionVersion ?? run.decisionVersion,
      replay: input.replay,
      sideEffects: input.sideEffects,
      ...(input.workspaceCommit ? { workspaceCommit: input.workspaceCommit } : {}),
      createdAt: now(),
    })
  }

  const recover = async (): Promise<RecoveryOutcome[]> => {
    const runs = await store.listRecoveryCandidates()
    const outcomes: RecoveryOutcome[] = []
    for (const run of runs) {
      const children = (await store.listChildren(run.id)).filter(
        (child) => !TERMINAL_STATUSES.has(child.status)
      )
      const checkpoints = await Promise.all(
        children.map((child) => store.getLatestCheckpoint(child.id))
      )
      const trajectory = await store.listTrajectory(run.id)
      const replaySafety = await Promise.all(
        children.map((child, index) =>
          isStoredChildReplaySafe(store, child.id, checkpoints[index], trajectory)
        )
      )
      const uncertain = replaySafety.some((safe) => !safe)
      const status: RecoveryOutcome["status"] = uncertain ? "needs_input" : "recovering"
      const at = now()
      const recovered = await store.updateRunIfCurrent(run.id, run, {
        status,
        updatedAt: at,
        recoveryReason: uncertain ? "uncertain_side_effect" : "checkpoint_replay",
      })
      if (!recovered) continue
      await Promise.all(
        children.map((child) =>
          store.updateChildIfCurrent(
            child.id,
            { status: child.status, updatedAt: child.updatedAt },
            { status, updatedAt: at }
          )
        )
      )
      outcomes.push({ runId: run.id, status })
    }
    return outcomes
  }

  const retryChild = async (
    childRunId: string,
    requestedHostRef?: string
  ): Promise<AgentTeamChildRun> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (["completed", "cancelled", "terminated"].includes(child.status)) {
      throw new Error(`Durable child ${childRunId} cannot be retried from ${child.status}`)
    }
    const run = await store.getRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)

    if (TERMINAL_STATUSES.has(run.status)) {
      throw new Error(`Durable AgentTeam run ${run.id} cannot be retried from ${run.status}`)
    }

    const checkpoint = await store.getLatestCheckpoint(childRunId)
    const safeToMigrate = await isStoredChildReplaySafe(store, childRunId, checkpoint)
    const changesHost =
      requestedHostRef !== undefined &&
      child.hostRef !== undefined &&
      requestedHostRef !== child.hostRef
    if (changesHost && !safeToMigrate) {
      throw new Error("Cross-host retry requires a safe checkpoint")
    }

    // Unsafe automatic retries remain pinned to the authenticated source host.
    // beginDurableDispatch consumes this marker before clearing waitingReason.
    const retryHostRef =
      requestedHostRef ?? (!safeToMigrate && child.hostRef ? child.hostRef : undefined)
    const at = now()
    const retried = await store.updateChildIfCurrent(childRunId, child, {
      status: "queued",
      error: undefined,
      dispatchLeaseId: undefined,
      dispatchLeaseExpiresAt: undefined,
      waitingReason: retryHostRef ? `retry_host:${retryHostRef}` : undefined,
      updatedAt: at,
    })
    if (!retried) throw new Error(`Durable child ${childRunId} changed before retry`)
    const recovering = await store.updateRunIfCurrent(run.id, run, {
      status: "recovering",
      recoveryReason: retryHostRef ? "operator_retry_host" : "operator_retry_auto",
      updatedAt: at,
    })
    if (!recovering) throw new Error(`Durable AgentTeam run ${run.id} changed before retry`)
    const updated = await store.getChild(childRunId)
    if (!updated) throw new Error(`Durable child disappeared during retry: ${childRunId}`)
    return updated
  }

  const setChildControlState = async (
    childRunId: string,
    action: "pause" | "resume" | "terminate"
  ): Promise<void> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const control = controls.get(childRunId)
    if (["completed", "failed", "cancelled", "terminated"].includes(child.status)) return
    if (action === "resume") {
      const run = await store.getRun(child.runId)
      if (!run || TERMINAL_STATUSES.has(run.status)) {
        throw new Error(`Durable child ${childRunId} cannot resume after its run stopped`)
      }
    }
    if (action === "terminate") {
      admissions
        .get(childRunId)
        ?.controller.abort(new DOMException("Child terminated", "AbortError"))
    }
    // Pause is cooperative: never kill an in-flight tool call. The current
    // turn reaches its next durable boundary, while new admissions wait.
    if (action === "pause") {
      const pausingAt = now()
      const admitted = await store.updateChildIfCurrent(
        childRunId,
        { status: child.status, updatedAt: child.updatedAt },
        { status: "pausing", updatedAt: pausingAt }
      )
      if (!admitted) {
        const changed = await store.getChild(childRunId)
        if (
          changed &&
          ["completed", "failed", "cancelled", "terminated"].includes(changed.status)
        ) {
          return
        }
        throw new Error(`Durable child ${childRunId} changed while pause was requested`)
      }
      admissions.get(childRunId)?.controller.abort(new DOMException("Child paused", "AbortError"))
    }
    const pauseSafe = action === "pause" ? await control?.pause?.() : undefined
    if (action === "resume" && child.remoteSessionId) {
      const checkpoint = await store.getLatestCheckpoint(childRunId)
      if (!(await isStoredChildReplaySafe(store, childRunId, checkpoint))) {
        throw new Error("Remote child resume requires a safe checkpoint")
      }
    }
    if (action === "resume" && !child.remoteSessionId) await control?.resume?.()
    if (action === "terminate") await control?.terminate?.()
    const current = await store.getChild(childRunId)
    if (!current) throw new Error(`Durable child disappeared during ${action}: ${childRunId}`)
    if (["completed", "failed", "cancelled", "terminated"].includes(current.status)) return
    if (action === "pause" && current.status !== "pausing") return
    if (action === "resume" && current.status !== child.status) return
    const status =
      action === "pause"
        ? pauseSafe === false
          ? "needs_input"
          : "paused"
        : action === "resume"
          ? "queued"
          : "terminated"
    const patch = {
      status,
      ...(action === "resume" && child.remoteSessionId
        ? { remoteSessionId: undefined, sessionId: undefined }
        : {}),
      ...(action === "terminate" ? { completedAt: now() } : {}),
      updatedAt: now(),
    } as const
    await store.updateChildIfCurrent(
      childRunId,
      { status: current.status, updatedAt: current.updatedAt },
      patch
    )
    if (action === "terminate" && child.remoteSessionId) {
      await remoteSessions.release(child.remoteSessionId)
    }
  }

  const sleepChild = async (childRunId: string): Promise<void> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (TERMINAL_STATUSES.has(child.status)) return
    await store.updateChildIfCurrent(
      childRunId,
      { status: child.status, updatedAt: child.updatedAt },
      { status: "sleeping", updatedAt: now() }
    )
  }

  const wakeChild = (childRunId: string): Promise<void> => {
    const pending = pendingWakes.get(childRunId)
    if (pending) return pending
    const waking = (async () => {
      const child = await store.getChild(childRunId)
      if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
      if (child.status !== "sleeping") return
      // Reuse resume's remote checkpoint gate and durable control transition.
      await setChildControlState(childRunId, "resume")
    })().finally(() => {
      pendingWakes.delete(childRunId)
    })
    pendingWakes.set(childRunId, waking)
    return waking
  }

  const beginTakeover = async (childRunId: string): Promise<AgentTeamChildRun> => {
    await setChildControlState(childRunId, "pause")
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    await store.appendTrajectory({
      runId: child.runId,
      childRunId,
      kind: "manual_takeover_started",
      correlationId: `takeover:${childRunId}`,
      payload: { workspacePath: child.workspacePath, branch: child.branch },
      createdAt: now(),
    })
    return child
  }

  const completeTakeover = async (input: {
    childRunId: string
    commands?: string[]
    diffContent?: string
    workspaceCommit?: string
  }): Promise<void> => {
    const child = await store.getChild(input.childRunId)
    if (!child) throw new Error(`Unknown durable child: ${input.childRunId}`)
    const bundle = createEvidenceBundle({
      store,
      runId: child.runId,
      childRunId: child.id,
      taskId: child.taskId,
      now,
    })
    for (const command of input.commands ?? []) {
      const content = persistable(command, "Manual takeover command failed PII redaction")
      await bundle.record({ kind: "command", title: "Manual command", content })
    }
    if (input.diffContent) {
      const content = persistable(input.diffContent, "Manual takeover diff failed PII redaction")
      await bundle.record({
        kind: "diff",
        title: "Manual workspace changes",
        content,
      })
    }
    if (input.workspaceCommit) {
      await bundle.record({
        kind: "commit",
        title: input.workspaceCommit,
        metadata: { sha: input.workspaceCommit, source: "manual_takeover" },
      })
    }
    const event = await store.appendTrajectory({
      runId: child.runId,
      childRunId: child.id,
      kind: "manual_takeover_completed",
      correlationId: `takeover:${child.id}`,
      payload: { commandCount: input.commands?.length ?? 0 },
      createdAt: now(),
    })
    await checkpoint(child.id, {
      trajectorySequence: event.sequence,
      replay: "safe",
      sideEffects: [],
      ...(input.workspaceCommit ? { workspaceCommit: input.workspaceCommit } : {}),
    })
    await setChildControlState(child.id, "resume")
  }

  return {
    /** The store this coordinator reads and writes run state through. */
    store,
    prepareRun,
    registerChild,
    withChildAdmission,
    withWorkspaceLease,
    attachLiveControl,
    steer,
    checkpoint,
    recover,
    retryChild,
    pauseChild: (childRunId: string) => setChildControlState(childRunId, "pause"),
    resumeChild: (childRunId: string) => setChildControlState(childRunId, "resume"),
    sleepChild,
    wakeChild,
    terminateChild: (childRunId: string) => setChildControlState(childRunId, "terminate"),
    beginTakeover,
    completeTakeover,
    setRunPaused(runId: string, paused: boolean) {
      if (paused) {
        pausedRuns.add(runId)
        for (const admission of admissions.values()) {
          if (admission.runId === runId) {
            admission.controller.abort(new DOMException("Run paused", "AbortError"))
          }
        }
        return
      }
      pausedRuns.delete(runId)
      for (const resolve of runResumeWaiters.get(runId) ?? []) resolve()
      runResumeWaiters.delete(runId)
    },
    schedulerSnapshot: scheduler.snapshot,
  }
}

export type DurableTeamCoordinator<TConstraints = unknown> = ReturnType<
  typeof createDurableTeamCoordinator<TConstraints>
>
