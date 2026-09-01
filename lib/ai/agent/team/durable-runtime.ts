import {
  appendAgentTeamTrajectory,
  createAgentTeamChildRun,
  createAgentTeamRun,
  createAgentTeamSteeringReceipt,
  getAgentTeamChildRun,
  getAgentTeamRun,
  getLatestAgentTeamCheckpoint,
  listAgentTeamChildRuns,
  listAgentTeamRecoveryCandidates,
  markAgentTeamCheckpoint,
  updateAgentTeamChildRun,
  updateAgentTeamChildRunIfCurrent,
  updateAgentTeamRun,
  updateAgentTeamSteeringReceipt,
} from "@/lib/db/agent-team-runtime"
import type { AgentTeam } from "@/types/agent/agent-team"
import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamRepositoryBinding,
  AgentTeamRunStatus,
  AgentTeamSideEffect,
  AgentTeamSteeringReceipt,
  AgentTeamWriteMode,
} from "@/types/agent/agent-team-runtime"
import type { AgentTeamResourcePolicy } from "@/types/agent/agent-team-runtime"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { createFairTeamScheduler } from "./fair-scheduler"
import { createDecisionLedger } from "./decision-ledger"
import { createEvidenceBundle } from "./evidence-bundle"
import { createExecutionRun, getExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"

export interface DurableChildControl {
  /** Must route through the runtime's PII-gated steering adapter. */
  steer(message: string, sourceMessageId: string): Promise<void>
  pause?(): Promise<boolean | void>
  resume?(): Promise<void>
  terminate?(): Promise<void>
}

export interface DurableTeamCoordinatorOptions {
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

function normalizeRepositories(team: AgentTeam): Map<string, AgentTeamRepositoryBinding> {
  const configured = team.config.repositories
  const repositories =
    configured && configured.length > 0
      ? configured
      : team.config.workingDir
        ? [
            {
              id: "primary",
              role: "primary" as const,
              path: team.config.workingDir,
              writable: true,
            },
          ]
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

function overlaps(a: string[], b: string[]): boolean {
  const normalize = (path: string) => path.replace(/^\.\//, "").replace(/\/$/, "")
  return a.some((left) =>
    b.some((right) => {
      const x = normalize(left)
      const y = normalize(right)
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
    })
  )
}

/**
 * Deep module for durable child control. Dexie is the source of truth; the
 * maps below contain process-local provider handles and writer locks only.
 */
export function createDurableTeamCoordinator(options: DurableTeamCoordinatorOptions = {}) {
  const now = options.now ?? Date.now
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

  const pumpAdmissions = (): void => {
    let next = scheduler.acquire(now())
    while (next) {
      admissionWaiters.get(next.id)?.()
      admissionWaiters.delete(next.id)
      next = scheduler.acquire(now())
    }
  }

  const prepareRun = async (team: AgentTeam, runId = newId("team-run")): Promise<string> => {
    if (team.config.runtimeVersion !== "durable-v2") {
      throw new Error("Durable coordinator requires runtimeVersion=durable-v2")
    }
    const repositories = normalizeRepositories(team)
    const at = now()
    const priority = team.config.resourcePolicy?.priority ?? 0
    const existing = await getAgentTeamRun(runId)
    if (!existing) {
      await createAgentTeamRun({
        id: runId,
        teamId: team.id,
        ...(team.projectId ? { projectId: team.projectId } : {}),
        objective: team.task,
        status: "running",
        priority,
        decisionVersion: 0,
        ...(team.config.environmentRef
          ? { environmentVersionId: team.config.environmentRef.versionId }
          : {}),
        resourceUsage: { ...EMPTY_USAGE, attempts: 0 },
        createdAt: at,
        startedAt: at,
        updatedAt: at,
      })
      const ledger = createDecisionLedger({ runId, leadId: team.leadId, now })
      for (const constraint of team.config.userConstraints ?? []) {
        await ledger.addUserConstraint(constraint)
      }
    } else if (existing.teamId !== team.id) {
      throw new Error(`Durable run ${runId} belongs to another team`)
    }
    // The execution row is addressed the way `agent-team-bridge` addresses it,
    // never by the bare `runId`. Both this path and `startSquadRun` create a
    // row for the same run, and the bridge's contract is that "the ids
    // converge because both derive from `agentTeamExecutionRunId`, so
    // whichever path runs first wins and the second is a no-op". Keying this
    // one on the bare id broke that: `journalSourceKey` is `${kind}:${sourceId}`,
    // so `team:<runId>` and `team:<teamId>` never deduped and the cockpit
    // listed the same run twice — the second copy with no `sessionId`, so its
    // coordination tab read "unavailable" and its gate receipts went nowhere.
    const executionRunId = agentTeamExecutionRunId(runId)
    const executionRun = await getExecutionRun(executionRunId)
    if (!executionRun) {
      await createExecutionRun({
        id: executionRunId,
        kind: "team",
        sourceId: runId,
        ...(team.projectId ? { projectId: team.projectId } : {}),
        // The objective, not a constant. On the uncarded path (a run with no
        // conversation) this is the only row that gets created, so a generic
        // title would be the only thing the run list could ever say about it.
        title: team.task || "Agent team run",
        status: "queued",
        currentRevision: 0,
        startedAt: at,
        updatedAt: at,
      })
      await runEventJournal.append(executionRunId, {
        id: `execution-event:${runId}:started`,
        ts: at,
        type: "run.started",
        visibility: "summary",
        payload: { summary: "Agent team run started" },
      })
    } else if (["waiting", "paused", "recovery_required"].includes(executionRun.status)) {
      await runEventJournal.append(executionRunId, {
        id: `execution-event:${runId}:resumed:${at}`,
        ts: at,
        type: "run.resumed",
        visibility: "summary",
        payload: { summary: "Agent team run resumed" },
      })
    }
    policies.set(runId, {
      teamId: team.id,
      writeMode: team.config.writeMode ?? "single-writer",
      repositories,
      resourcePolicy: team.config.resourcePolicy ?? {
        priority,
        maxConcurrentChildren: team.config.maxConcurrentTeammates ?? 1,
      },
    })
    return runId
  }

  const registerChild = async (input: RegisterDurableChildInput): Promise<AgentTeamChildRun> => {
    const run = await getAgentTeamRun(input.runId)
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
    await createAgentTeamChildRun(child)
    await appendAgentTeamTrajectory({
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
    operation: () => Promise<T> | T
  ): Promise<T> => {
    if (request.access === "read") return operation()
    const policy = policies.get(request.runId)
    const mode = policy?.writeMode ?? "single-writer"
    const key = `${request.runId}:${request.repositoryId}`

    if (mode === "isolated-parallel") {
      if (!request.fileOwnership || request.fileOwnership.length === 0) {
        throw new Error("Isolated parallel writers require explicit file ownership")
      }
      const active = activeOwnership.get(key) ?? []
      if (active.some((lease) => overlaps(lease.paths, request.fileOwnership!))) {
        throw new Error("Parallel writer ownership overlaps an active lease")
      }
      const lease: ActiveOwnership = { leaseId: newId("writer"), paths: request.fileOwnership }
      activeOwnership.set(key, [...active, lease])
      try {
        return await operation()
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
    if (previous) await previous
    try {
      return await operation()
    } finally {
      release()
      if (writerTails.get(key) === tail) writerTails.delete(key)
    }
  }

  const withChildAdmission = async <T>(
    childRunId: string,
    operation: () => Promise<T> | T
  ): Promise<T> => {
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (["pausing", "paused", "sleeping", "needs_input"].includes(child.status)) {
      throw new Error(
        `Durable child ${childRunId} is not accepting new turns while ${child.status}`
      )
    }
    if (["completed", "failed", "cancelled", "terminated"].includes(child.status)) {
      throw new Error(`Durable child ${childRunId} is terminal: ${child.status}`)
    }
    const run = await getAgentTeamRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)
    const policy = policies.get(child.runId)
    const resource = policy?.resourcePolicy ?? {
      priority: run.priority,
      maxConcurrentChildren: 1,
    }
    if (pausedRuns.has(run.id) || ["pausing", "paused", "sleeping"].includes(run.status)) {
      await new Promise<void>((resolve) => {
        const waiters = runResumeWaiters.get(run.id) ?? new Set()
        waiters.add(resolve)
        runResumeWaiters.set(run.id, waiters)
      })
    }
    const usage = run.resourceUsage
    const wallTimeMs = Math.max(0, now() - (run.startedAt ?? run.createdAt))
    const exhausted =
      (resource.maxTokens !== undefined && (usage?.totalTokens ?? 0) >= resource.maxTokens) ||
      (resource.maxCostUsd !== undefined && (usage?.costUsd ?? 0) >= resource.maxCostUsd) ||
      (resource.maxWallTimeMs !== undefined && wallTimeMs >= resource.maxWallTimeMs)
    if (exhausted) {
      const at = now()
      await Promise.all([
        updateAgentTeamRun(run.id, {
          status: "needs_input",
          recoveryReason: "resource_budget_exhausted",
          updatedAt: at,
        }),
        updateAgentTeamChildRun(childRunId, {
          status: "needs_input",
          error: "Resource budget exhausted",
          updatedAt: at,
        }),
      ])
      throw new Error("Durable AgentTeam resource budget exhausted")
    }
    await updateAgentTeamChildRun(childRunId, { status: "queued", updatedAt: now() })
    scheduler.enqueue({
      id: childRunId,
      teamId: child.teamId,
      priority: resource.priority,
      enqueuedAt: now(),
      teamConcurrency: resource.maxConcurrentChildren,
    })
    await new Promise<void>((resolve) => {
      admissionWaiters.set(childRunId, resolve)
      pumpAdmissions()
    })
    await updateAgentTeamChildRun(childRunId, { status: "running", updatedAt: now() })
    try {
      return await operation()
    } finally {
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
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const at = now()
    const persistedMessage = redactText(message).redacted
    if (!hasNoLeakingPii(persistedMessage)) {
      throw new Error("AgentTeam steering still contains PII after redaction")
    }
    const receipt: AgentTeamSteeringReceipt = {
      id: newId("team-steer"),
      runId: child.runId,
      childRunId,
      message: persistedMessage,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    }
    await createAgentTeamSteeringReceipt(receipt)
    await appendAgentTeamTrajectory({
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
      await updateAgentTeamSteeringReceipt(receipt.id, "delivered", deliveredAt)
      await appendAgentTeamTrajectory({
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
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const run = await getAgentTeamRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)
    return markAgentTeamCheckpoint({
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
    const runs = await listAgentTeamRecoveryCandidates()
    const outcomes: RecoveryOutcome[] = []
    for (const run of runs) {
      const children = await listAgentTeamChildRuns(run.id)
      const checkpoints = await Promise.all(
        children.map((child) => getLatestAgentTeamCheckpoint(child.id))
      )
      const uncertain =
        children.length > 0 &&
        checkpoints.some(
          (candidate) =>
            !candidate ||
            candidate.replay === "needs_input" ||
            candidate.sideEffects.some(
              (effect) =>
                effect.state === "unknown" ||
                (effect.state === "intent" && effect.replay !== "safe")
            )
        )
      const status: RecoveryOutcome["status"] = uncertain ? "needs_input" : "recovering"
      const at = now()
      await updateAgentTeamRun(run.id, {
        status,
        updatedAt: at,
        recoveryReason: uncertain ? "uncertain_side_effect" : "checkpoint_replay",
      })
      await Promise.all(
        children
          .filter((child) => child.status !== "completed")
          .map((child) => updateAgentTeamChildRun(child.id, { status, updatedAt: at }))
      )
      outcomes.push({ runId: run.id, status })
    }
    return outcomes
  }

  const retryChild = async (
    childRunId: string,
    requestedHostRef?: string
  ): Promise<AgentTeamChildRun> => {
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (["completed", "cancelled", "terminated"].includes(child.status)) {
      throw new Error(`Durable child ${childRunId} cannot be retried from ${child.status}`)
    }
    const run = await getAgentTeamRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)

    const checkpoint = await getLatestAgentTeamCheckpoint(childRunId)
    const safeToMigrate =
      checkpoint?.replay === "safe" &&
      checkpoint.sideEffects.every(
        (effect) =>
          effect.state !== "unknown" && !(effect.state === "intent" && effect.replay !== "safe")
      )
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
    await Promise.all([
      updateAgentTeamChildRun(childRunId, {
        status: "queued",
        error: undefined,
        dispatchLeaseId: undefined,
        dispatchLeaseExpiresAt: undefined,
        waitingReason: retryHostRef ? `retry_host:${retryHostRef}` : undefined,
        updatedAt: at,
      }),
      updateAgentTeamRun(run.id, {
        status: "recovering",
        recoveryReason: retryHostRef ? "operator_retry_host" : "operator_retry_auto",
        updatedAt: at,
      }),
    ])
    const updated = await getAgentTeamChildRun(childRunId)
    if (!updated) throw new Error(`Durable child disappeared during retry: ${childRunId}`)
    return updated
  }

  const setChildControlState = async (
    childRunId: string,
    action: "pause" | "resume" | "terminate"
  ): Promise<void> => {
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const control = controls.get(childRunId)
    if (["completed", "failed", "cancelled", "terminated"].includes(child.status)) return
    // Pause is cooperative: never kill an in-flight tool call. The current
    // turn reaches its next durable boundary, while new admissions wait.
    if (action === "pause") {
      const pausingAt = now()
      const admitted = await updateAgentTeamChildRunIfCurrent(
        childRunId,
        { status: child.status, updatedAt: child.updatedAt },
        { status: "pausing", updatedAt: pausingAt }
      )
      if (!admitted) {
        const changed = await getAgentTeamChildRun(childRunId)
        if (
          changed &&
          ["completed", "failed", "cancelled", "terminated"].includes(changed.status)
        ) {
          return
        }
        throw new Error(`Durable child ${childRunId} changed while pause was requested`)
      }
    }
    const pauseSafe = action === "pause" ? await control?.pause?.() : undefined
    if (action === "resume" && child.remoteSessionId) {
      const checkpoint = await getLatestAgentTeamCheckpoint(childRunId)
      if (checkpoint?.replay !== "safe") {
        throw new Error("Remote child resume requires a safe checkpoint")
      }
    }
    if (action === "resume" && !child.remoteSessionId) await control?.resume?.()
    if (action === "terminate") await control?.terminate?.()
    const current = await getAgentTeamChildRun(childRunId)
    if (!current) throw new Error(`Durable child disappeared during ${action}: ${childRunId}`)
    if (["completed", "failed", "cancelled", "terminated"].includes(current.status)) return
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
    if (action === "pause") {
      await updateAgentTeamChildRunIfCurrent(
        childRunId,
        { status: current.status, updatedAt: current.updatedAt },
        patch
      )
    } else {
      await updateAgentTeamChildRun(childRunId, patch)
    }
    if (action === "terminate" && child.remoteSessionId) {
      const { removeManagedFleetSession } = await import("@/lib/fleet/managed-session-projection")
      await removeManagedFleetSession(child.remoteSessionId).catch(() => false)
    }
  }

  const sleepChild = async (childRunId: string): Promise<void> => {
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    await updateAgentTeamChildRun(childRunId, { status: "sleeping", updatedAt: now() })
  }

  const wakeChild = async (childRunId: string): Promise<void> => {
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    await controls.get(childRunId)?.resume?.()
    await updateAgentTeamChildRun(childRunId, { status: "running", updatedAt: now() })
  }

  const beginTakeover = async (childRunId: string): Promise<AgentTeamChildRun> => {
    await setChildControlState(childRunId, "pause")
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    await appendAgentTeamTrajectory({
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
    const child = await getAgentTeamChildRun(input.childRunId)
    if (!child) throw new Error(`Unknown durable child: ${input.childRunId}`)
    const bundle = createEvidenceBundle({
      runId: child.runId,
      childRunId: child.id,
      taskId: child.taskId,
      now,
    })
    for (const command of input.commands ?? []) {
      const content = redactText(command).redacted
      if (!hasNoLeakingPii(content)) throw new Error("Manual takeover command failed PII redaction")
      await bundle.record({ kind: "command", title: "Manual command", content })
    }
    if (input.diffContent) {
      const content = redactText(input.diffContent).redacted
      if (!hasNoLeakingPii(content)) throw new Error("Manual takeover diff failed PII redaction")
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
    const event = await appendAgentTeamTrajectory({
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
        return
      }
      pausedRuns.delete(runId)
      for (const resolve of runResumeWaiters.get(runId) ?? []) resolve()
      runResumeWaiters.delete(runId)
    },
    schedulerSnapshot: scheduler.snapshot,
  }
}

export type DurableTeamCoordinator = ReturnType<typeof createDurableTeamCoordinator>

let sharedCoordinator: DurableTeamCoordinator | undefined

export function getDurableTeamCoordinator(): DurableTeamCoordinator {
  sharedCoordinator ??= createDurableTeamCoordinator()
  return sharedCoordinator
}

export function __resetDurableTeamCoordinatorForTesting(): void {
  sharedCoordinator = undefined
}
