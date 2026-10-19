/**
 * The run driver (ADR-0237): one persisted, leased, resumable job per run.
 *
 * The driver walks the plan `planRun` lays out (`../recursion.ts`), one wave
 * of independent steps at a time, at most `maxParallelRuns` side by side:
 *
 *   capture check → tool surface → retrieve lessons → base rollouts
 *   → proposals → their rollouts → compositions → their rollouts (per round
 *   in sequential mode) → select → reflect → approval / adoption
 *
 * Every step is a row keyed by its label. A step that already succeeded (or
 * was skipped) is never run again; a step left `running` by a driver that died
 * is re-run as a new attempt, which books new usage rows under a new attempt
 * number. Spend is never accumulated in memory: before every step the ledger
 * is folded again from the run's usage rows (`../ledger.ts`), and the step is
 * refused when the worst observed cost of its kind would cross a ceiling.
 *
 * Ownership is a lease renewed while the driver works. Every run write is a
 * compare-and-swap; a write that loses means someone else (a cancel from
 * another window, a resumed driver after this one's lease lapsed) owns the
 * run now, and this driver stops without writing again.
 *
 * Failure policy:
 * - a rollout that fails for infrastructure reasons (timeout, outage, rate
 *   limit) is not evidence about its harness: it is retried once, then fails
 *   the run;
 * - an editor or selector call that throws is retried once, then fails the
 *   run; an invalid proposal is not a failure (the editor contract handles it);
 * - a reflection that fails is recorded and the run goes on: it decides
 *   nothing;
 * - a step the budget cannot afford ends the run as `budget_exceeded` with the
 *   base kept, except at a sequential round boundary, where the run stops early
 *   and selects among the rounds it finished.
 */

import type { Character } from "@cognia/agent-config-types"
import type {
  HarnessEvolutionRun,
  HarnessEvolutionStep,
  HarnessExecutionEvidence,
  HarnessRunDecision,
  HarnessRunAdoption,
  HarnessRunStatus,
  HarnessStepKind,
} from "@/types/harness/evolution"
import type { HarnessExperience } from "@/types/harness/experience"
import type { HarnessScope, HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { runWithConcurrency } from "@/lib/plugin/core/concurrency"
import { canAfford, type Reservation } from "../budget"
import { isInfrastructureError, pickReusableRollout, rolloutCacheKey } from "../cache"
import { buildContextTree, type ContextDecision, type ContextPoolEntry } from "../context-tree"
import { environmentFingerprint, redactEvidenceText } from "../evidence"
import {
  applyRetrievedVerdict,
  evictionCandidates,
  experienceFromReflection,
  experienceScopeFor,
  findConflicts,
  findDuplicate,
  markExperienceAdopted,
  mergeExperience,
  retrieveExperiences,
} from "../experience"
import { foldRunUsage, ledgerFromUsage, runUsageSessionId, type UsageRowLike } from "../ledger"
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  transitionRun,
  type HarnessRunPatch,
} from "../machine"
import { roleOfDimension } from "../prompts"
import {
  BASE,
  decisionLabelsFor,
  evidenceLabelsFor,
  planRun,
  rolloutLabel,
  statusForStep,
  type PlannedStep,
} from "../recursion"
import type { ReflectionCandidate, ReflectionInput } from "../reflect"
import { assessHarnessRisk, requiresApproval } from "../risk"
import { BASE_LABEL, selectFinal, type SelectionHarness, type SelectionJudge } from "../select"
import {
  canonicalHash,
  diffHarness,
  driftedSkills,
  forkHarnessSnapshot,
  type CapturedSkillInput,
} from "../snapshot"
import { componentsToTree, unifiedTreeDiff } from "../tree"
import type { CapturedHarness } from "./capture"
import type { EditorSessionInput, EditorSessionOutcome } from "./editor-runner"
import type { JudgeContext, ReflectorOutcome } from "./judges"
import { PROBE_DENIED_TOOLS, PROBE_PERMISSION_PROFILE } from "./probe-policy"
import type { ProbeInput, ProbeOutcome, ProbeToolSurface } from "./probe-runner"

/** How long a claimed run stays owned without a renewal. */
export const LEASE_TTL_MS = 90_000
/** How often a working driver renews its lease. */
export const LEASE_RENEW_MS = 30_000
/** Wall-time ceiling of one rollout, under the run's remaining wall time. */
export const ROLLOUT_TIMEOUT_MS = 20 * 60_000
/** Executions of one step before its failure fails the run. */
export const MAX_STEP_ATTEMPTS = 2
const NOTES_MAX_CHARS = 8_000

// ── errors ───────────────────────────────────────────────────────────────────

/** Abort reason when a person cancels the run. */
export class HarnessRunCancelledError extends Error {
  constructor() {
    super("The run was cancelled.")
    this.name = "HarnessRunCancelledError"
  }
}

/** Someone else owns the run now (a cancel elsewhere, a lapsed lease); stop without writing. */
export class HarnessRunStoppedError extends Error {
  constructor(readonly reason: "terminal" | "lease-lost") {
    super(
      reason === "terminal"
        ? "The run was finished elsewhere."
        : "The run's lease was taken over by another driver."
    )
    this.name = "HarnessRunStoppedError"
  }
}

/** The budget cannot afford the next step. */
export class HarnessBudgetStopError extends Error {
  constructor(
    readonly dimension: string,
    readonly detail: string
  ) {
    super(`Budget reached (${dimension}): ${detail}`)
    this.name = "HarnessBudgetStopError"
  }
}

/** The agent changed under a run that measured its old harness. */
export class HarnessDriftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HarnessDriftError"
  }
}

class StepFailedError extends Error {
  constructor(
    readonly label: string,
    cause: unknown
  ) {
    super(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "StepFailedError"
  }
}

/** Errors a second attempt cannot fix. */
const PERMANENT_ERRORS = new Set([
  "InputFileChangedError",
  "HarnessModelUnavailableError",
  "HarnessPiiBlockedError",
  "HarnessCaptureError",
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── dependencies ─────────────────────────────────────────────────────────────

export interface HarnessDriverStore {
  getRun(id: string): Promise<HarnessEvolutionRun | undefined>
  saveRun(next: HarnessEvolutionRun, expectedVersion: number): Promise<HarnessEvolutionRun>
  claimLease(
    runId: string,
    ownerId: string,
    ttlMs: number,
    now: number
  ): Promise<HarnessEvolutionRun | null>
  listSteps(runId: string): Promise<HarnessEvolutionStep[]>
  putStep(step: HarnessEvolutionStep): Promise<void>
  getSnapshot(id: string): Promise<HarnessSnapshotV1 | undefined>
  putSnapshot(snapshot: HarnessSnapshotV1): Promise<void>
  listRolloutsByCacheKey(key: string): Promise<HarnessEvolutionStep[]>
  listExperiences(options: {
    characterId?: string
    domain?: string
    includeDisabled?: boolean
  }): Promise<HarnessExperience[]>
  getExperience(id: string): Promise<HarnessExperience | undefined>
  putExperience(experience: HarnessExperience): Promise<void>
  updateExperience(
    id: string,
    patch: (current: HarnessExperience) => HarnessExperience
  ): Promise<HarnessExperience | undefined>
  deleteExperience(id: string): Promise<void>
  prune(characterId: string): Promise<unknown>
}

/** The step executors. Production binds them to the real runners; tests fake them. */
export interface HarnessDriverRunners {
  discoverSurface(input: {
    run: HarnessEvolutionRun
    snapshot: HarnessSnapshotV1
    baseCharacter: Character
    carriedSkillIds: readonly string[]
  }): Promise<ProbeToolSurface>
  probe(input: ProbeInput): Promise<ProbeOutcome>
  editor(input: EditorSessionInput): Promise<EditorSessionOutcome>
  judge(ctx: JudgeContext): SelectionJudge
  reflect(
    ctx: JudgeContext & { reflection: ReflectionInput; labels: readonly string[] }
  ): Promise<ReflectorOutcome>
  adopt(input: {
    run: HarnessEvolutionRun
    chosen: HarnessSnapshotV1
    base: HarnessSnapshotV1
    carriedSkillIds: readonly string[]
    approvedBy: HarnessRunAdoption["approvedBy"]
    setAsWorkspaceDefault?: boolean
    currentContentHash: string
  }): Promise<HarnessRunAdoption>
}

export interface HarnessDriverDeps {
  store: HarnessDriverStore
  runners: HarnessDriverRunners
  capture(
    characterId: string,
    options: { scope: HarnessScope; projectId?: string }
  ): Promise<CapturedHarness>
  /** Usage rows booked under `harness:<runId>`. */
  listUsage(sessionId: string): Promise<UsageRowLike[]>
  /** Per-agent library capacity from the settings. */
  experienceCap(): Promise<number>
  /** Announce a run that waits for a person. Best-effort. */
  notifyAwaitingApproval(run: HarnessEvolutionRun): Promise<void>
  ownerId: string
  now(): number
  newId(): string
  leaseTtlMs?: number
  leaseRenewMs?: number
}

// ── the run handle: every run write goes through it ──────────────────────────

interface RunHandle {
  readonly run: HarnessEvolutionRun
  /** Move to `to` (no-op when already there) with `patch`. */
  transition(to: HarnessRunStatus, patch?: HarnessRunPatch): Promise<HarnessEvolutionRun>
  /** Change fields without changing the status. */
  patch(patch: HarnessRunPatch): Promise<HarnessEvolutionRun>
  renew(): Promise<void>
  release(): Promise<void>
}

function createRunHandle(initial: HarnessEvolutionRun, deps: HarnessDriverDeps): RunHandle {
  let current = initial
  let chain: Promise<unknown> = Promise.resolve()
  const write = (next: (run: HarnessEvolutionRun) => HarnessEvolutionRun | null) => {
    const task = chain.then(async () => {
      const candidate = next(current)
      if (!candidate) return current
      try {
        current = await deps.store.saveRun(candidate, current.version)
      } catch (error) {
        const stored = await deps.store.getRun(current.id)
        if (!stored || isTerminalRunStatus(stored.status)) {
          throw new HarnessRunStoppedError("terminal")
        }
        if (stored.version !== current.version) throw new HarnessRunStoppedError("lease-lost")
        throw error
      }
      return current
    })
    chain = task.catch(() => undefined)
    return task
  }
  const ttl = deps.leaseTtlMs ?? LEASE_TTL_MS
  return {
    get run() {
      return current
    },
    transition: (to, patch = {}) =>
      write((run) =>
        run.status === to && Object.keys(patch).length === 0
          ? null
          : run.status === to
            ? { ...run, ...patch, version: run.version + 1, updatedAt: deps.now() }
            : transitionRun(run, to, patch, deps.now())
      ),
    patch: (patch) =>
      write((run) => ({ ...run, ...patch, version: run.version + 1, updatedAt: deps.now() })),
    renew: async () => {
      await write((run) =>
        isTerminalRunStatus(run.status)
          ? null
          : {
              ...run,
              owner: { ownerId: deps.ownerId, leaseExpiresAt: deps.now() + ttl },
              version: run.version + 1,
              updatedAt: deps.now(),
            }
      )
    },
    release: async () => {
      await write((run) => {
        if (!run.owner) return null
        const next = { ...run, version: run.version + 1, updatedAt: deps.now() }
        delete next.owner
        return next
      })
    },
  }
}

function linkedController(parent?: AbortSignal): AbortController {
  const controller = new AbortController()
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason)
    else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true })
  }
  return controller
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Group the plan into waves of steps that may run side by side. */
export function planWaves(plan: readonly PlannedStep[]): PlannedStep[][] {
  const waves: PlannedStep[][] = []
  let wave: PlannedStep[] = []
  for (const step of plan) {
    const head = wave[0]
    const dependsOnWave = wave.some(
      (s) => step.input === s.label || step.rolls === s.label || (step.pool ?? []).includes(s.label)
    )
    const breaks =
      !head ||
      head.kind !== step.kind ||
      head.round !== step.round ||
      dependsOnWave ||
      step.kind === "select" ||
      step.kind === "reflect"
    if (head && breaks) {
      waves.push(wave)
      wave = []
    }
    wave.push(step)
  }
  if (wave.length) waves.push(wave)
  return waves
}

/** One line on how a rollout went, for the history a later round reads. */
export function outcomeLine(evidence: HarnessExecutionEvidence): string {
  const checks = evidence.validation
  const passed = checks.filter((c) => c.status === "passed").length
  const parts = [
    evidence.error
      ? `failed (${evidence.error.slice(0, 200)})`
      : evidence.delivered
        ? "delivered"
        : "did not deliver",
    ...(checks.length ? [`${passed}/${checks.length} checks passed`] : []),
    `${evidence.metrics.toolFailures} tool failures`,
    `${evidence.metrics.steps} steps`,
    ...(evidence.metrics.costUsd !== undefined ? [`$${evidence.metrics.costUsd.toFixed(3)}`] : []),
  ]
  return parts.join(", ")
}

function stepId(runId: string, label: string): string {
  return `${runId}:${label}`
}

const DONE: ReadonlySet<HarnessEvolutionStep["status"]> = new Set(["succeeded", "skipped"])

// ── the driver ───────────────────────────────────────────────────────────────

interface RunContext {
  handle: RunHandle
  deps: HarnessDriverDeps
  signal: AbortSignal
  plan: PlannedStep[]
  kindOf: (label: string) => HarnessStepKind | undefined
  steps: Map<string, HarnessEvolutionStep>
  snapshots: Map<string, HarnessSnapshotV1>
  base: HarnessSnapshotV1
  character: Character
  carriedSkillIds: string[]
  /** The library skills as they were when this driver started, by id, for reuse drift checks. */
  librarySkills: ReadonlyMap<string, CapturedSkillInput>
  environmentFingerprint: string
  surface: ProbeToolSurface
  retrieved: HarnessExperience[]
  /** Cost and calls reserved by steps in flight, so a wave cannot overcommit. */
  inFlight: { costUsd: number; modelCalls: number }
}

/**
 * Drive a run until it finishes, waits for a person, or is stopped. Returns
 * the run as this driver last saw it. Never throws for a run-level failure:
 * the failure is written to the run.
 */
export async function driveHarnessRun(
  runId: string,
  deps: HarnessDriverDeps,
  options: { signal?: AbortSignal } = {}
): Promise<HarnessEvolutionRun | undefined> {
  const claimed = await deps.store.claimLease(
    runId,
    deps.ownerId,
    deps.leaseTtlMs ?? LEASE_TTL_MS,
    deps.now()
  )
  if (!claimed) return deps.store.getRun(runId)
  const handle = createRunHandle(claimed, deps)
  if (claimed.status === "awaiting_approval") {
    // A person decides what happens next; nothing to drive.
    await handle.release().catch(() => undefined)
    return handle.run
  }
  const controller = linkedController(options.signal)
  const renewal = setInterval(() => {
    handle.renew().catch((error) => {
      controller.abort(
        error instanceof HarnessRunStoppedError ? error : new HarnessRunStoppedError("lease-lost")
      )
    })
  }, deps.leaseRenewMs ?? LEASE_RENEW_MS)
  let ctx: RunContext | undefined
  try {
    ctx = await prepare(handle, deps, controller.signal)
    await execute(ctx)
  } catch (error) {
    await settleFailure(handle, deps, ctx, error, controller.signal)
  } finally {
    clearInterval(renewal)
  }
  return handle.run
}

async function settleFailure(
  handle: RunHandle,
  deps: HarnessDriverDeps,
  ctx: RunContext | undefined,
  error: unknown,
  signal: AbortSignal
): Promise<void> {
  const reason = signal.aborted ? signal.reason : undefined
  if (error instanceof HarnessRunStoppedError || reason instanceof HarnessRunStoppedError) return
  if (isTerminalRunStatus(handle.run.status)) return
  if (ctx)
    await interruptRunningSteps(
      ctx,
      reason instanceof HarnessRunCancelledError ? "cancelled" : errorMessage(error)
    )
  const ledger = ctx ? await currentLedger(ctx).catch(() => undefined) : undefined
  try {
    if (reason instanceof HarnessRunCancelledError || error instanceof HarnessRunCancelledError) {
      await handle.transition("cancelled", { error: "Cancelled." })
    } else if (error instanceof HarnessBudgetStopError) {
      await handle.transition("budget_exceeded", {
        error: error.message,
        decision: {
          outcome: "keep-base",
          reason: `The run stopped at its budget (${error.detail}); the base harness stays.`,
          requiresApproval: false,
        },
        ...(ledger ? { ledger } : {}),
      })
    } else {
      await handle.transition("failed", {
        error: errorMessage(error).slice(0, 2_000),
        ...(ledger ? { ledger } : {}),
      })
    }
  } catch (writeError) {
    if (!(writeError instanceof HarnessRunStoppedError)) {
      console.warn("Harness run: could not record its failure", writeError)
    }
  }
  await deps.store.prune(handle.run.characterId).catch(() => undefined)
}

async function interruptRunningSteps(ctx: RunContext, why: string): Promise<void> {
  for (const step of ctx.steps.values()) {
    if (step.status !== "running") continue
    const next: HarnessEvolutionStep = {
      ...step,
      status: "interrupted",
      error: why.slice(0, 2_000),
      endedAt: ctx.deps.now(),
      updatedAt: ctx.deps.now(),
    }
    ctx.steps.set(step.label, next)
    await ctx.deps.store.putStep(next).catch(() => undefined)
  }
}

async function prepare(
  handle: RunHandle,
  deps: HarnessDriverDeps,
  signal: AbortSignal
): Promise<RunContext> {
  if (handle.run.status === "queued") {
    await handle.transition("snapshotting")
  } else if (isActiveRunStatus(handle.run.status)) {
    // The previous driver died mid-phase (its lease lapsed). Resume through
    // interrupted, from which every phase may be re-entered.
    await handle.transition("interrupted")
  }
  const run = handle.run
  if (!run.baseSnapshotId) throw new Error("The run has no base harness.")
  const base = await deps.store.getSnapshot(run.baseSnapshotId)
  if (!base) throw new Error("The run's base harness is gone.")

  // The base was captured when the run was created. Rollouts and editors keep
  // measuring that harness, so a run whose agent moved since then is stopped:
  // its result would describe a harness that no longer exists.
  const captured = await deps.capture(run.characterId, {
    scope: run.config.scope,
    ...(run.projectId ? { projectId: run.projectId } : {}),
  })
  if (captured.snapshot.contentHash !== base.contentHash) {
    throw new HarnessDriftError(
      "The agent's instructions, skills or tool rules changed since this run started; start a new run."
    )
  }
  if (captured.snapshot.runtimeFingerprint !== base.runtimeFingerprint) {
    throw new HarnessDriftError(
      "The agent's model, runtime or MCP servers (or the app version) changed since this run started; its earlier rollouts are not comparable. Start a new run."
    )
  }
  signal.throwIfAborted()

  const plan = planRun(run.config.mode, run.config.k)
  const kinds = new Map(plan.map((s) => [s.label, s.kind]))
  const executor = run.config.models.executor
  const fingerprint = await environmentFingerprint({
    runtimeFingerprint: base.runtimeFingerprint,
    isolation: run.task.isolation,
    ...((executor?.providerId ?? captured.character.providerId)
      ? { executorProviderId: executor?.providerId ?? captured.character.providerId }
      : {}),
    ...((executor?.model ?? captured.character.model)
      ? { executorModel: executor?.model ?? captured.character.model }
      : {}),
    maxTurns: run.config.budget.maxTurnsPerRollout,
    probePolicyHash: await canonicalHash({
      probe: run.config.probe,
      denied: PROBE_DENIED_TOOLS,
      profile: PROBE_PERMISSION_PROFILE,
    }),
  })
  const surface = await deps.runners.discoverSurface({
    run,
    snapshot: base,
    baseCharacter: captured.character,
    carriedSkillIds: captured.carriedSkillIds,
  })
  const steps = new Map((await deps.store.listSteps(run.id)).map((s) => [s.label, s]))
  const ctx: RunContext = {
    handle,
    deps,
    signal,
    plan,
    kindOf: (label) => kinds.get(label),
    steps,
    snapshots: new Map([[base.id, base]]),
    base,
    character: captured.character,
    carriedSkillIds: [...captured.carriedSkillIds],
    librarySkills: new Map(captured.skills.map((input) => [input.skill.id, input])),
    environmentFingerprint: fingerprint,
    surface,
    retrieved: [],
    inFlight: { costUsd: 0, modelCalls: 0 },
  }
  ctx.retrieved = await retrieveLessons(ctx)
  return ctx
}

/** The lessons this run's editors are given: retrieved once, then reloaded by id on resume. */
async function retrieveLessons(ctx: RunContext): Promise<HarnessExperience[]> {
  const { run } = ctx.handle
  if (!run.config.useExperiences) return []
  const store = ctx.deps.store
  if (run.retrievedExperienceIds) {
    const rows = await Promise.all(run.retrievedExperienceIds.map((id) => store.getExperience(id)))
    return rows.filter((r): r is HarnessExperience => Boolean(r))
  }
  const entries = await store.listExperiences({})
  const characterIds = [
    ctx.character.id,
    ...(ctx.character.variant?.baseId ? [ctx.character.variant.baseId] : []),
  ]
  const matches = retrieveExperiences(entries, {
    characterIds,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    domain: run.task.domain,
    taskText: `${run.task.title}\n${run.task.prompt}`,
    editable: run.config.editable,
    runtimeFingerprint: ctx.base.runtimeFingerprint,
  })
  const retrieved = matches.map((m) => m.experience)
  // Persist the ids before counting, so a resume neither re-retrieves nor
  // counts the same use twice.
  await ctx.handle.patch({ retrievedExperienceIds: retrieved.map((e) => e.id) })
  for (const e of retrieved) {
    await store.updateExperience(e.id, (current) => ({
      ...current,
      retrievedCount: current.retrievedCount + 1,
    }))
  }
  return retrieved
}

async function currentLedger(ctx: RunContext) {
  const rows = await ctx.deps.listUsage(runUsageSessionId(ctx.handle.run.id))
  const finished = [...ctx.steps.values()].filter((s) => s.status === "succeeded")
  return ledgerFromUsage({
    rows,
    runId: ctx.handle.run.id,
    kindOf: ctx.kindOf,
    finishedRollouts: finished.filter((s) => s.kind === "rollout" && !s.cacheHitOf).length,
    finishedSessions: finished.filter((s) => s.kind !== "rollout").length,
    ...(ctx.handle.run.startedAt !== undefined ? { startedAt: ctx.handle.run.startedAt } : {}),
  })
}

function reservationFor(kind: HarnessStepKind): Reservation {
  return { modelCalls: kind === "rollout" ? 0 : 1 }
}

/** Refuse a step the budget cannot afford, counting what steps in flight have reserved. */
async function assertAffordable(ctx: RunContext, kind: HarnessStepKind) {
  const ledger = await currentLedger(ctx)
  const budget = ctx.handle.run.config.budget
  const withInFlight = {
    ...ledger,
    costUsd: ledger.costUsd + ctx.inFlight.costUsd,
    modelCalls: ledger.modelCalls + ctx.inFlight.modelCalls,
  }
  const verdict = canAfford(withInFlight, budget, kind, ctx.deps.now(), reservationFor(kind))
  if (!verdict.ok) throw new HarnessBudgetStopError(verdict.dimension, verdict.detail)
  return ledger
}

async function putStep(ctx: RunContext, step: HarnessEvolutionStep): Promise<void> {
  ctx.steps.set(step.label, step)
  await ctx.deps.store.putStep(step)
}

async function snapshotOf(ctx: RunContext, label: string): Promise<HarnessSnapshotV1> {
  if (label === BASE) return ctx.base
  const id = ctx.steps.get(label)?.snapshotId
  if (!id) throw new Error(`Stage ${label} produced no harness.`)
  const cached = ctx.snapshots.get(id)
  if (cached) return cached
  const row = await ctx.deps.store.getSnapshot(id)
  if (!row) throw new Error(`The harness of ${label} is gone.`)
  ctx.snapshots.set(id, row)
  return row
}

/**
 * Run one planned step to success, retrying once when the failure may be
 * transient. A step already done is returned as it is.
 */
async function executeStep(
  ctx: RunContext,
  planned: PlannedStep,
  work: (attempt: number) => Promise<Partial<HarnessEvolutionStep>>,
  options: { free?: boolean } = {}
): Promise<HarnessEvolutionStep> {
  const existing = ctx.steps.get(planned.label)
  if (existing && DONE.has(existing.status)) return existing
  const first = (existing?.attempts ?? 0) + 1
  for (let attempt = first; ; attempt++) {
    ctx.signal.throwIfAborted()
    // A step that spends nothing (a reused rollout) is not held to the budget.
    const ledger = options.free ? undefined : await assertAffordable(ctx, planned.kind)
    const reserve = ledger?.maxObservedCostUsd[planned.kind] ?? 0
    const callReserve = options.free ? 0 : reservationFor(planned.kind).modelCalls
    const startedAt = ctx.deps.now()
    const base: HarnessEvolutionStep = {
      id: stepId(ctx.handle.run.id, planned.label),
      runId: ctx.handle.run.id,
      label: planned.label,
      kind: planned.kind,
      ...(planned.dim ? { dim: planned.dim } : {}),
      ...(planned.round !== undefined ? { round: planned.round } : {}),
      status: "running",
      attempts: attempt,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      startedAt,
      updatedAt: startedAt,
    }
    await putStep(ctx, base)
    ctx.inFlight.costUsd += reserve
    ctx.inFlight.modelCalls += callReserve
    let result: Partial<HarnessEvolutionStep> | undefined
    let failure: unknown
    try {
      result = await work(attempt)
    } catch (error) {
      failure = error
    } finally {
      ctx.inFlight.costUsd -= reserve
      ctx.inFlight.modelCalls -= callReserve
    }
    const spend = await spendOf(ctx, planned.label)
    const endedAt = ctx.deps.now()
    if (result) {
      const done: HarnessEvolutionStep = {
        ...base,
        ...spend,
        ...result,
        status: "succeeded",
        endedAt,
        updatedAt: endedAt,
      }
      await putStep(ctx, done)
      return done
    }
    const aborted = ctx.signal.aborted
    await putStep(ctx, {
      ...base,
      ...spend,
      status: aborted ? "interrupted" : "failed",
      error: errorMessage(failure).slice(0, 2_000),
      endedAt,
      updatedAt: endedAt,
    })
    if (aborted) throw ctx.signal.reason ?? failure
    const permanent = failure instanceof Error && PERMANENT_ERRORS.has(failure.name)
    if (permanent || attempt - first + 1 >= MAX_STEP_ATTEMPTS) {
      throw new StepFailedError(planned.label, failure)
    }
  }
}

/** Everything a step's attempts booked, read back from the usage rows. */
async function spendOf(ctx: RunContext, label: string) {
  const rows = await ctx.deps.listUsage(runUsageSessionId(ctx.handle.run.id))
  const spend = foldRunUsage(rows, ctx.handle.run.id, ctx.kindOf).byLabel.get(label)
  if (!spend) return { inputTokens: 0, outputTokens: 0, modelCalls: 0 }
  return {
    ...(spend.costUnknown ? {} : { costUsd: spend.costUsd }),
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    modelCalls: spend.modelCalls,
  }
}

/** Run a wave's steps side by side; the first failure stops new starts and is rethrown once the wave settles. */
async function runWave(
  ctx: RunContext,
  wave: readonly PlannedStep[],
  run: (step: PlannedStep, signal: AbortSignal) => Promise<unknown>
): Promise<void> {
  const controller = linkedController(ctx.signal)
  const waveCtx = { ...ctx, signal: controller.signal }
  const errors: unknown[] = []
  await runWithConcurrency(wave, ctx.handle.run.config.budget.maxParallelRuns, async (step) => {
    if (controller.signal.aborted) return
    try {
      await run(step, waveCtx.signal)
    } catch (error) {
      errors.push(error)
      if (!controller.signal.aborted) controller.abort(error)
    }
  })
  if (errors.length) {
    // Report the cause, not the sibling aborts it triggered.
    throw errors.find((e) => !(e instanceof DOMException && e.name === "AbortError")) ?? errors[0]
  }
}

async function execute(ctx: RunContext): Promise<void> {
  const waves = planWaves(ctx.plan)
  for (const wave of waves) {
    const head = wave[0]
    if (head.kind === "select") {
      await selectStep(ctx, head)
      continue
    }
    if (head.kind === "reflect") {
      await reflectStep(ctx, head)
      continue
    }
    if (wave.every((s) => DONE.has(ctx.steps.get(s.label)?.status ?? "pending"))) continue
    if (head.kind === "propose" && head.round !== undefined && head.round > 1) {
      const stop = await sequentialStop(ctx, head.round)
      if (stop) {
        await stopEarly(ctx, head.round, stop)
        continue
      }
    }
    await ctx.handle.transition(statusForStep(head), {
      ...(head.round !== undefined ? { round: head.round } : {}),
    })
    await runWave(ctx, wave, (step, signal) =>
      step.kind === "rollout"
        ? rolloutStep({ ...ctx, signal }, step)
        : editorStep({ ...ctx, signal }, step)
    )
    await ctx.handle.patch({ ledger: await currentLedger(ctx) })
  }
  await finish(ctx)
}

// ── sequential early stop ────────────────────────────────────────────────────

/**
 * Why a sequential run should not start round `round`, or `null`. It stops when
 * the last round changed nothing (another round would start from the same
 * harness with the same evidence), or when the budget cannot pay for a whole
 * round plus the final selection.
 */
async function sequentialStop(ctx: RunContext, round: number): Promise<string | null> {
  const previous = ctx.plan.filter((s) => s.round === round - 1)
  const stages = previous.filter((s) => s.kind === "propose" || s.kind === "compose")
  const unchanged = stages.every((s) => {
    const row = ctx.steps.get(s.label)
    return row?.keptBase || row?.fellBack
  })
  if (unchanged && stages.length > 0) {
    return `converged: round ${round - 1} left the harness unchanged`
  }
  const ledger = await currentLedger(ctx)
  const budget = ctx.handle.run.config.budget
  const roundSteps = ctx.plan.filter((s) => s.round === round)
  const sessions = roundSteps.filter((s) => s.kind !== "rollout").length
  const rollouts = roundSteps.length - sessions
  const reserve =
    sessions *
      Math.max(ledger.maxObservedCostUsd.propose ?? 0, ledger.maxObservedCostUsd.compose ?? 0) +
    rollouts * (ledger.maxObservedCostUsd.rollout ?? 0) +
    (ledger.maxObservedCostUsd.select ?? 0)
  const roundCalls = sessions + 1
  const verdict = canAfford(ledger, budget, "propose", ctx.deps.now(), {
    costUsd: reserve,
    modelCalls: roundCalls,
  })
  if (!verdict.ok) return `budget: ${verdict.detail}`
  if (ledger.costUsd + reserve > budget.maxCostUsd) {
    return `budget: another round (~$${reserve.toFixed(2)}) would pass the $${budget.maxCostUsd} limit`
  }
  const spans = previous
    .map((s) => ctx.steps.get(s.label))
    .filter((s): s is HarnessEvolutionStep => !!s?.startedAt && !!s.endedAt)
  if (spans.length && ledger.startedAt !== undefined) {
    const roundMs =
      Math.max(...spans.map((s) => s.endedAt as number)) -
      Math.min(...spans.map((s) => s.startedAt as number))
    if (ctx.deps.now() - ledger.startedAt + roundMs > budget.maxWallTimeMs) {
      return "budget: another round would pass the wall-time limit"
    }
  }
  return null
}

async function stopEarly(ctx: RunContext, fromRound: number, reason: string): Promise<void> {
  const now = ctx.deps.now()
  for (const s of ctx.plan) {
    if (s.round === undefined || s.round < fromRound) continue
    const existing = ctx.steps.get(s.label)
    if (existing && DONE.has(existing.status)) continue
    await putStep(ctx, {
      id: stepId(ctx.handle.run.id, s.label),
      runId: ctx.handle.run.id,
      label: s.label,
      kind: s.kind,
      ...(s.dim ? { dim: s.dim } : {}),
      round: s.round,
      status: "skipped",
      error: reason,
      attempts: existing?.attempts ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      updatedAt: now,
    })
  }
  const finals = ctx.handle.run.finalLabels.filter((label) => {
    const round = ctx.plan.find((s) => s.label === label)?.round
    return round === undefined || round < fromRound
  })
  await ctx.handle.patch({ stopReason: reason, finalLabels: finals })
}

// ── rollouts ─────────────────────────────────────────────────────────────────

async function rolloutStep(ctx: RunContext, planned: PlannedStep): Promise<HarnessEvolutionStep> {
  const run = ctx.handle.run
  const existing = ctx.steps.get(planned.label)
  if (existing && DONE.has(existing.status)) return existing
  const snapshot = await snapshotOf(ctx, planned.rolls ?? BASE)
  const key = await rolloutCacheKey({
    harnessContentHash: snapshot.contentHash,
    taskInputHash: run.task.inputHash,
    environmentFingerprint: ctx.environmentFingerprint,
    replicate: planned.replicate ?? 1,
  })
  const id = stepId(run.id, planned.label)
  const stored = (await ctx.deps.store.listRolloutsByCacheKey(key)).filter((s) => s.id !== id)
  const reusable = stored.length
    ? pickReusableRollout(stored, key, ctx.deps.now(), {
        driftedSkills: await driftedSkills(snapshot, ctx.librarySkills),
      })
    : undefined
  if (reusable?.evidence) {
    const evidence = { ...reusable.evidence, snapshotId: snapshot.id }
    return executeStep(
      ctx,
      planned,
      async () => ({ snapshotId: snapshot.id, evidence, cacheHitOf: reusable.id, cacheKey: key }),
      { free: true }
    )
  }
  return executeStep(ctx, planned, async (attempt) => {
    const ledger = await currentLedger(ctx)
    const budget = run.config.budget
    const remainingUsd = Math.max(0, budget.maxCostUsd - ledger.costUsd - ctx.inFlight.costUsd)
    const elapsed = run.startedAt !== undefined ? ctx.deps.now() - run.startedAt : 0
    const remainingMs = Math.max(1_000, budget.maxWallTimeMs - elapsed)
    const outcome = await ctx.deps.runners.probe({
      run,
      label: planned.label,
      attempt,
      snapshot,
      baseCharacter: ctx.character,
      carriedSkillIds: ctx.carriedSkillIds,
      environmentFingerprint: ctx.environmentFingerprint,
      surface: ctx.surface,
      maxBudgetUsd: remainingUsd,
      timeoutMs: Math.min(ROLLOUT_TIMEOUT_MS, remainingMs),
      signal: ctx.signal,
    })
    if (isInfrastructureError(outcome.evidence.error)) {
      // Not evidence about the harness: a base made to look bad by an outage
      // would let any candidate "win".
      throw new Error(`The rollout did not get a fair attempt: ${outcome.evidence.error}`)
    }
    return { snapshotId: snapshot.id, evidence: outcome.evidence, cacheKey: key }
  })
}

// ── editor stages ────────────────────────────────────────────────────────────

async function editorStep(ctx: RunContext, planned: PlannedStep): Promise<HarnessEvolutionStep> {
  const run = ctx.handle.run
  return executeStep(ctx, planned, async (attempt) => {
    const input = await snapshotOf(ctx, planned.input ?? BASE)
    const evidenceOf = (label: string) => {
      const row = ctx.steps.get(label)
      return row?.status === "succeeded" ? row.evidence : undefined
    }
    const rollouts = evidenceLabelsFor(planned, ctx.plan).flatMap((label) => {
      const evidence = evidenceOf(label)
      return evidence ? [{ label, evidence }] : []
    })
    const pool: ContextPoolEntry[] = []
    for (const label of planned.pool ?? []) {
      const row = ctx.steps.get(label)
      if (row?.status !== "succeeded") continue
      const rollout = evidenceOf(rolloutLabel(label))
      pool.push({
        label,
        components: (await snapshotOf(ctx, label)).components,
        ...(rollout ? { rollout } : {}),
        ...(row.notes ? { notes: row.notes } : {}),
      })
    }
    const decisions: ContextDecision[] = decisionLabelsFor(planned, ctx.plan).flatMap((label) => {
      const row = ctx.steps.get(label)
      if (row?.status !== "succeeded") return []
      const rollout = evidenceOf(rolloutLabel(label))
      return [
        {
          label,
          ...(row.dim ? { dim: row.dim } : {}),
          ...(row.round !== undefined ? { round: row.round } : {}),
          notes: row.notes ?? "",
          ...(row.keptBase ? { keptBase: true } : {}),
          ...(row.fellBack ? { fellBack: true } : {}),
          ...(rollout ? { outcome: outcomeLine(rollout) } : {}),
        },
      ]
    })
    const context = buildContextTree({
      task: run.task,
      current: input.components,
      editable: run.config.editable,
      rollouts,
      ...(pool.length ? { pool } : {}),
      ...(decisions.length ? { decisions } : {}),
      ...(ctx.retrieved.length ? { experiences: ctx.retrieved } : {}),
    })
    const outcome = await ctx.deps.runners.editor({
      run,
      label: planned.label,
      attempt,
      role: roleOfDimension(planned.dim ?? "INV"),
      ...(planned.round !== undefined ? { round: planned.round } : {}),
      context,
      current: input.components,
      policy: {
        editable: run.config.editable,
        // An agent with no tool allow-list has every tool; only a listed set is a ceiling.
        ...(ctx.character.allowedTools?.length ? { knownTools: ctx.character.allowedTools } : {}),
      },
      agent: ctx.character,
      signal: ctx.signal,
    })
    let snapshotId = input.id
    if (outcome.outcome === "changed") {
      const forked = await forkHarnessSnapshot(input, {
        id: ctx.deps.newId(),
        components: outcome.components,
        origin: {
          kind: planned.kind === "compose" ? "composed" : "candidate",
          runId: run.id,
          label: planned.label,
        },
        createdAt: ctx.deps.now(),
      })
      await ctx.deps.store.putSnapshot(forked)
      ctx.snapshots.set(forked.id, forked)
      snapshotId = forked.id
    }
    return {
      snapshotId,
      notes: redactEvidenceText(outcome.notes).slice(0, NOTES_MAX_CHARS),
      ...(outcome.outcome === "kept" ? { keptBase: true } : {}),
      ...(outcome.outcome === "fell-back"
        ? { fellBack: true, error: outcome.errors.join("\n").slice(0, 2_000) }
        : {}),
    }
  })
}

// ── selection ────────────────────────────────────────────────────────────────

async function selectStep(ctx: RunContext, planned: PlannedStep): Promise<void> {
  const run = ctx.handle.run
  if (run.decision && ctx.steps.get(planned.label)?.status === "succeeded") return
  await ctx.handle.transition("evaluating")
  const baseEvidence = ctx.plan
    .filter((s) => s.kind === "rollout" && s.rolls === BASE)
    .flatMap((s) => {
      const e = ctx.steps.get(s.label)?.evidence
      return e ? [e] : []
    })
  if (baseEvidence.length === 0)
    throw new Error("No base rollout finished; there is nothing to compare against.")
  const finals: SelectionHarness[] = []
  const unchanged: string[] = []
  for (const label of ctx.handle.run.finalLabels) {
    const rollout = ctx.steps.get(rolloutLabel(label))
    if (rollout?.status !== "succeeded" || !rollout.evidence) continue
    const snapshot = await snapshotOf(ctx, label)
    if (snapshot.contentHash === ctx.base.contentHash) {
      unchanged.push(label)
      continue
    }
    finals.push({
      label,
      snapshotId: snapshot.id,
      components: snapshot.components,
      evidence: [rollout.evidence],
    })
  }
  await executeStep(ctx, planned, async (attempt) => {
    const selection =
      finals.length === 0
        ? {
            outcome: "keep-base" as const,
            method: "no-candidate" as const,
            reason: unchanged.length
              ? "Every final harness was identical to the base."
              : "No final harness finished its rollout.",
            regressed: [],
            dominant: [],
          }
        : await selectFinal({
            base: {
              label: BASE_LABEL,
              snapshotId: ctx.base.id,
              components: ctx.base.components,
              evidence: baseEvidence,
            },
            finals,
            seed: run.config.seed,
            judge: ctx.deps.runners.judge({
              run,
              attempt,
              agent: ctx.character,
              signal: ctx.signal,
            }),
          })
    let decision: HarnessRunDecision
    if (selection.outcome === "adopt" && selection.chosenSnapshotId) {
      const chosen = await snapshotOf(ctx, selection.chosenLabel as string)
      const assessment = assessHarnessRisk(
        ctx.base.components,
        chosen.components,
        diffHarness(ctx.base, chosen)
      )
      decision = {
        outcome: "adopt",
        reason: selection.reason,
        chosenLabel: selection.chosenLabel as string,
        chosenSnapshotId: chosen.id,
        risk: assessment.risk,
        riskReasons: assessment.reasons,
        requiresApproval: requiresApproval(
          assessment.risk,
          run.config.scope,
          run.config.autoAdoptLowRisk
        ),
      }
    } else {
      decision = { outcome: "keep-base", reason: selection.reason, requiresApproval: false }
    }
    await ctx.handle.patch({ decision })
    return {
      selection: {
        method: selection.method,
        regressed: selection.regressed,
        dominant: selection.dominant,
        unchanged,
        ...("anonymized" in selection && selection.anonymized
          ? { anonymized: selection.anonymized }
          : {}),
        ...("verdict" in selection && selection.verdict ? { verdict: selection.verdict } : {}),
      },
      ...(decision.chosenSnapshotId ? { snapshotId: decision.chosenSnapshotId } : {}),
    }
  })
  await ctx.handle.patch({ ledger: await currentLedger(ctx) })
}

// ── reflection and the library ───────────────────────────────────────────────

async function reflectStep(ctx: RunContext, planned: PlannedStep): Promise<void> {
  const existing = ctx.steps.get(planned.label)
  if (
    existing &&
    (DONE.has(existing.status) ||
      (existing.status === "failed" && existing.attempts >= MAX_STEP_ATTEMPTS))
  ) {
    return
  }
  const run = ctx.handle.run
  const decision = run.decision
  if (!decision) throw new Error("The run reached reflection without a decision.")
  await ctx.handle.transition("reflecting")
  const stages = ctx.plan.filter((s) => s.kind === "propose" || s.kind === "compose")
  const changed = stages.some((s) => {
    const row = ctx.steps.get(s.label)
    return row?.status === "succeeded" && !row.keptBase && !row.fellBack
  })
  const skip = async (why: string) => {
    const now = ctx.deps.now()
    await putStep(ctx, {
      id: stepId(run.id, planned.label),
      runId: run.id,
      label: planned.label,
      kind: "reflect",
      status: "skipped",
      error: why,
      attempts: existing?.attempts ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      updatedAt: now,
    })
  }
  if (!changed) {
    await skip("No editor changed the harness, so there is no edit to attribute.")
    return
  }
  try {
    await assertAffordable(ctx, "reflect")
  } catch (error) {
    if (!(error instanceof HarnessBudgetStopError)) throw error
    await skip(`Skipped at the budget: ${error.detail}`)
    return
  }

  const baseCandidates = ctx.plan
    .filter((s) => s.kind === "rollout" && s.rolls === BASE)
    .flatMap((s) => {
      const e = ctx.steps.get(s.label)?.evidence
      return e ? [{ label: s.label, evidence: e }] : []
    })
  const baseTree = componentsToTree(ctx.base.components)
  const candidates: ReflectionCandidate[] = []
  for (const s of stages) {
    const row = ctx.steps.get(s.label)
    if (row?.status !== "succeeded") continue
    const snapshot = await snapshotOf(ctx, s.label)
    const rollout = ctx.steps.get(rolloutLabel(s.label))
    candidates.push({
      label: s.label,
      ...(s.dim ? { dim: s.dim } : {}),
      ...(s.round !== undefined ? { round: s.round } : {}),
      notes: row.notes ?? "",
      diff: unifiedTreeDiff(baseTree, componentsToTree(snapshot.components), {
        from: "base",
        to: s.label,
      }),
      ...(rollout?.status === "succeeded" && rollout.evidence
        ? { evidence: rollout.evidence }
        : {}),
      ...(row.keptBase ? { keptBase: true } : {}),
      ...(row.fellBack ? { fellBack: true } : {}),
    })
  }
  const labels = candidates.map((c) => c.label)

  try {
    await executeStep(ctx, planned, async (attempt) => {
      const outcome = await ctx.deps.runners.reflect({
        run,
        attempt,
        agent: ctx.character,
        signal: ctx.signal,
        reflection: {
          task: run.task,
          base: baseCandidates,
          candidates,
          decision,
          retrieved: ctx.retrieved,
        },
        labels,
      })
      if (!outcome.parsed) throw new Error("The reflector's answer was not a usable reflection.")
      const record = await updateLibrary(ctx, outcome.parsed, outcome.model)
      return { reflection: record }
    })
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? error
    if (error instanceof HarnessRunStoppedError) throw error
    // A reflection decides nothing; the run goes on without its lesson.
    console.warn("Harness run: reflection failed", error)
  }
}

async function updateLibrary(
  ctx: RunContext,
  parsed: NonNullable<ReflectorOutcome["parsed"]>,
  reflectorModel: string | undefined
) {
  const run = ctx.handle.run
  const store = ctx.deps.store
  const now = ctx.deps.now()
  for (const verdict of parsed.retrieved) {
    await store.updateExperience(verdict.id, (e) => applyRetrievedVerdict(e, verdict.verdict, now))
  }
  const record: NonNullable<HarnessEvolutionStep["reflection"]> = {
    edits: parsed.edits.map((e) => ({ ...e, candidates: [...e.candidates] })),
    retrieved: parsed.retrieved.map((r) => ({ ...r })),
    ...(parsed.droppedExperience ? { droppedExperience: parsed.droppedExperience } : {}),
  }
  if (!parsed.experience) return record

  const effective = parsed.edits.filter((e) => e.verdict === "helped" || e.verdict === "hurt")
  const evidenceRefs = [
    ...ctx.plan
      .filter((s) => s.kind === "rollout" && s.rolls === BASE)
      .map((s) => stepId(run.id, s.label)),
    ...effective.flatMap((e) => e.candidates.map((c) => stepId(run.id, rolloutLabel(c)))),
  ]
  const incoming = experienceFromReflection({
    id: ctx.deps.newId(),
    now,
    run,
    scope: experienceScopeFor(run),
    proposed: parsed.experience,
    edits: parsed.edits,
    runtimeFingerprint: ctx.base.runtimeFingerprint,
    ...(reflectorModel ? { modelFamily: reflectorModel } : {}),
    evidenceRefs,
    // The decision is not in effect yet: adoption comes after reflection.
    adopted: false,
  })
  const sameDomain = await store.listExperiences({ domain: run.task.domain, includeDisabled: true })
  const duplicate = findDuplicate(incoming, sameDomain)
  let experienceId: string
  if (duplicate) {
    const merged = mergeExperience(duplicate, incoming, now)
    await store.putExperience(merged)
    experienceId = merged.id
    record.mergedInto = merged.id
  } else {
    const conflicts = findConflicts(incoming, sameDomain)
    await store.putExperience({ ...incoming, conflictsWith: conflicts })
    for (const id of conflicts) {
      await store.updateExperience(id, (e) => ({
        ...e,
        conflictsWith: [...new Set([...e.conflictsWith, incoming.id])],
        updatedAt: now,
      }))
    }
    experienceId = incoming.id
    if (conflicts.length) record.conflictsWith = conflicts
  }
  record.experienceId = experienceId
  await ctx.handle.patch({
    experienceIds: [...new Set([...run.experienceIds, experienceId])],
  })
  const cap = await ctx.deps.experienceCap()
  const own = await store.listExperiences({ characterId: run.characterId, includeDisabled: true })
  for (const id of evictionCandidates(own, cap)) {
    if (id === experienceId) continue
    await store.deleteExperience(id)
  }
  return record
}

// ── the end of a run ─────────────────────────────────────────────────────────

async function finish(ctx: RunContext): Promise<void> {
  const run = ctx.handle.run
  const decision = run.decision
  if (!decision) throw new Error("The run finished without a decision.")
  // A resumed run whose reflection already ended enters here from interrupted.
  if (ctx.handle.run.status !== "reflecting") await ctx.handle.transition("reflecting")
  const ledger = await currentLedger(ctx)
  if (decision.outcome === "keep-base") {
    await ctx.handle.transition("completed", { ledger })
  } else if (decision.requiresApproval) {
    await ctx.handle.transition("awaiting_approval", { ledger })
    await ctx.handle.release()
    await ctx.deps.notifyAwaitingApproval(ctx.handle.run).catch(() => undefined)
    return
  } else {
    await ctx.handle.patch({ ledger })
    await adoptDecision(ctx.handle, ctx.deps, { approvedBy: "auto-low-risk" })
  }
  await ctx.deps.store.prune(run.characterId).catch(() => undefined)
}

/**
 * Write the decision's harness to its scope, mark the run's lessons adopted
 * and complete the run. A failed adoption fails the run with the reason.
 */
async function adoptDecision(
  handle: RunHandle,
  deps: HarnessDriverDeps,
  input: { approvedBy: HarnessRunAdoption["approvedBy"]; setAsWorkspaceDefault?: boolean }
): Promise<void> {
  await handle.transition("adopting")
  const run = handle.run
  const decision = run.decision
  try {
    if (!decision?.chosenSnapshotId || !decision.chosenLabel || !run.baseSnapshotId) {
      throw new Error("The run has nothing to adopt.")
    }
    const [base, chosen] = await Promise.all([
      deps.store.getSnapshot(run.baseSnapshotId),
      deps.store.getSnapshot(decision.chosenSnapshotId),
    ])
    if (!base || !chosen) throw new Error("A harness this run measured is gone.")
    const current = await deps.capture(run.characterId, {
      scope: run.config.scope,
      ...(run.projectId ? { projectId: run.projectId } : {}),
    })
    const adoption = await deps.runners.adopt({
      run,
      chosen,
      base,
      carriedSkillIds: current.carriedSkillIds,
      approvedBy: input.approvedBy,
      ...(input.setAsWorkspaceDefault !== undefined
        ? { setAsWorkspaceDefault: input.setAsWorkspaceDefault }
        : {}),
      currentContentHash: current.snapshot.contentHash,
    })
    const now = deps.now()
    for (const id of run.experienceIds) {
      await deps.store
        .updateExperience(id, (e) =>
          markExperienceAdopted(
            e,
            { chosenLabel: decision.chosenLabel as string, chosenSnapshotId: chosen.id },
            now
          )
        )
        .catch(() => undefined)
    }
    await handle.transition("completed", { adoption })
  } catch (error) {
    if (error instanceof HarnessRunStoppedError) throw error
    await handle.transition("failed", {
      error: `Adoption failed: ${errorMessage(error)}`.slice(0, 2_000),
    })
  }
}

/**
 * Adopt a run that waits for approval, as a person decided. Returns the run
 * as stored afterwards. `null` when the run is not waiting for approval or
 * another driver holds it.
 */
export async function approveHarnessRunWith(
  runId: string,
  deps: HarnessDriverDeps,
  options: { setAsWorkspaceDefault?: boolean } = {}
): Promise<HarnessEvolutionRun | null> {
  const claimed = await deps.store.claimLease(
    runId,
    deps.ownerId,
    deps.leaseTtlMs ?? LEASE_TTL_MS,
    deps.now()
  )
  if (!claimed) return null
  const handle = createRunHandle(claimed, deps)
  if (claimed.status !== "awaiting_approval") {
    await handle.release().catch(() => undefined)
    return null
  }
  await adoptDecision(handle, deps, {
    approvedBy: "person",
    ...(options.setAsWorkspaceDefault !== undefined
      ? { setAsWorkspaceDefault: options.setAsWorkspaceDefault }
      : {}),
  })
  await deps.store.prune(claimed.characterId).catch(() => undefined)
  return handle.run
}
