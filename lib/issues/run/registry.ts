/**
 * IssueRunRegistry — the run adapters and the orchestration around them.
 *
 * Shape follows `lib/scheduler/task-scheduler.ts:registerTaskExecutor`
 * (last-write-wins registration + registration-wait listeners, because
 * adapters register from deferred boot chunks). It deliberately does NOT
 * follow `lib/issues/sources/registry.ts`'s swallow-and-report `listAll`: a
 * dispatch that fails must fail loudly, never turn into a silent queued row.
 *
 * Three orchestrations live here because every entry point (detail panel Run
 * button, IM card, reconciler) must apply the same ownership rules:
 *   - `startIssueRun`   — refuse-or-dispatch, then the runtime takes
 *                          `in_progress` (`applyRuntimeIssueStatus`).
 *   - `settleIssueRunAndIssue` — settle the row, then advance the issue to
 *                          `in_review` (or hand it back to `todo` on cancel).
 *                          NEVER to `done`.
 *   - `reconcileIssueRuns` — poll every active run through its adapter; the
 *                          recovery path after a reload, and the fan-in for
 *                          the engine-table watchers in `install.ts`.
 */

import type { IssueActor, IssueRun, IssueRunKind, IssueRunWakeup } from "@/types/issues"
import { isActiveIssueRunStatus } from "@/types/issues"
import { getIssue, listIssues } from "@/lib/db/issues"
import { applyRuntimeIssueStatus } from "@/lib/db/issues"
import { openBlockers } from "@/lib/issues/relations"
import { linkRunPullRequests } from "@/lib/issues/pull-requests"
import { getIssueProject } from "@/lib/db/issue-projects"
import {
  getIssueRun,
  hasActiveIssueRun,
  listIssueRuns,
  settleIssueRun,
  type SettleIssueRunInput,
} from "@/lib/db/issue-runs"
import type {
  IssueRunAdapter,
  IssueRunConversation,
  IssueRunOrigin,
  IssueRunRefusalReason,
  IssueRunTarget,
  IssueRunVerdict,
} from "./types"
import { isNamedRunOrigin } from "./types"

/** Raised by `startIssueRun` for a policy refusal — machine-readable, i18n at the UI. */
export class IssueRunRefusedError extends Error {
  readonly reason: IssueRunRefusalReason
  readonly detail?: string

  constructor(reason: IssueRunRefusalReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = "IssueRunRefusedError"
    this.reason = reason
    if (detail) this.detail = detail
    Object.setPrototypeOf(this, IssueRunRefusedError.prototype)
  }
}

export class IssueRunRegistry {
  private readonly adapters = new Map<string, IssueRunAdapter>()
  private readonly waiters = new Set<() => void>()

  register(adapter: IssueRunAdapter): void {
    this.adapters.set(adapter.id, adapter)
    for (const waiter of this.waiters) waiter()
  }

  unregister(id: string): void {
    this.adapters.delete(id)
  }

  get(id: string): IssueRunAdapter | undefined {
    return this.adapters.get(id)
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  list(): ReadonlyArray<IssueRunAdapter> {
    return Array.from(this.adapters.values())
  }

  listByKind(kind: IssueRunKind): ReadonlyArray<IssueRunAdapter> {
    return this.list().filter((adapter) => adapter.kind === kind)
  }

  clear(): void {
    this.adapters.clear()
  }

  /**
   * Resolve when `id` is registered, or after `timeoutMs`. Mirrors
   * `waitForTaskExecutor`: an IM callback that lands before the deferred boot
   * chunk registered the adapters waits briefly instead of failing.
   */
  waitFor(id: string, timeoutMs: number): Promise<boolean> {
    if (this.adapters.has(id)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        this.waiters.delete(check)
        clearTimeout(timer)
        resolve(value)
      }
      const check = () => {
        if (this.adapters.has(id)) finish(true)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.waiters.add(check)
    })
  }
}

let singleton: IssueRunRegistry | null = null

export function getIssueRunRegistry(): IssueRunRegistry {
  if (!singleton) singleton = new IssueRunRegistry()
  return singleton
}

/** Test-only. */
export function resetIssueRunRegistry(): void {
  singleton = null
}

export function registerIssueRunAdapter(
  adapter: IssueRunAdapter,
  registry: IssueRunRegistry = getIssueRunRegistry()
): void {
  registry.register(adapter)
}

/** Load the target an adapter decides on. */
export async function loadIssueRunTarget(issueId: string): Promise<IssueRunTarget | undefined> {
  const issue = await getIssue(issueId)
  if (!issue) return undefined
  const project = await getIssueProject(issue.issueProjectId)
  return { issue, project }
}

export interface IssueRunOption {
  adapter: IssueRunAdapter
  verdict: IssueRunVerdict
}

/**
 * Every registered adapter's verdict for an issue — what the Run dialog lists.
 * Tracker-level refusals (`issue-finished`, `run-active`) apply to all
 * adapters and are returned as such so the dialog can explain itself once.
 */
export async function listIssueRunOptions(
  issueId: string,
  registry: IssueRunRegistry = getIssueRunRegistry(),
  origin: IssueRunOrigin = "interactive"
): Promise<IssueRunOption[]> {
  const target = await loadIssueRunTarget(issueId)
  if (!target) return []
  const blanket = await trackerVerdict(target, origin)
  const adapters = registry.list()
  return Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      verdict: blanket.ok ? await adapter.canRun(target) : blanket,
    }))
  )
}

async function trackerVerdict(
  target: IssueRunTarget,
  origin: IssueRunOrigin
): Promise<IssueRunVerdict> {
  const { issue } = target
  if (issue.statusCategory === "completed" || issue.statusCategory === "canceled") {
    return { ok: false, reason: "issue-finished" }
  }
  if (issue.triage === "pending" && !isNamedRunOrigin(origin)) {
    return { ok: false, reason: "issue-in-triage" }
  }
  if (await hasActiveIssueRun(issue.id)) return { ok: false, reason: "run-active" }
  // A human may still drag a blocked issue anywhere (the tracker does not
  // argue), but dispatching an agent onto work that waits on other work is
  // wasted effort, so the engines refuse it and say which issues stand in
  // the way.
  if (issue.blockedBy?.length) {
    const rows = await listIssues({ projectId: issue.projectId })
    const blockers = openBlockers(issue, new Map(rows.map((row) => [row.id, row])))
    if (blockers.length > 0) {
      return {
        ok: false,
        reason: "blocked",
        detail: blockers.map((blocker) => blocker.identifier).join(", "),
      }
    }
  }
  return { ok: true }
}

export interface StartIssueRunInput {
  issueId: string
  adapterId: string
  by: IssueActor
  origin: IssueRunOrigin
  /** The IM thread behind an `im` origin, so an engine can ask there. */
  conversation?: IssueRunConversation
  options?: Readonly<Record<string, unknown>>
  /** Text appended to what the engine receives. See `IssueRunStartContext.brief`. */
  brief?: string
  /** Lineage when an issue wakeup is the caller. */
  wakeup?: IssueRunWakeup
}

/**
 * Refuse-or-dispatch. Throws `IssueRunRefusedError` for a policy refusal and
 * rethrows engine failures untouched. On success the issue is `in_progress`
 * and the returned run row is active.
 */
export async function startIssueRun(
  input: StartIssueRunInput,
  registry: IssueRunRegistry = getIssueRunRegistry()
): Promise<IssueRun> {
  const adapter = registry.get(input.adapterId)
  if (!adapter) throw new IssueRunRefusedError("adapter-missing", input.adapterId)

  const target = await loadIssueRunTarget(input.issueId)
  if (!target) throw new Error(`Issue not found: ${input.issueId}`)

  const blanket = await trackerVerdict(target, input.origin)
  if (!blanket.ok) throw new IssueRunRefusedError(blanket.reason, blanket.detail)
  const verdict = await adapter.canRun(target)
  if (!verdict.ok) throw new IssueRunRefusedError(verdict.reason, verdict.detail)

  const run = await adapter.start(target, {
    by: input.by,
    origin: input.origin,
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(input.options ? { options: input.options } : {}),
    ...(input.brief ? { brief: input.brief } : {}),
    ...(input.wakeup ? { wakeup: input.wakeup } : {}),
  })
  await applyRuntimeIssueStatus(target.issue.id, "in_progress", input.by)
  return run
}

/** The runtime actor stamped on status changes the bridge makes on an engine's behalf. */
export function runtimeActorFor(run: IssueRun): IssueActor {
  return {
    kind: run.kind === "agent-team" ? "team" : "agent",
    id: run.targetId,
    label: run.adapterId,
  }
}

/**
 * Settle a run and move its issue on. Terminal success/failure both advance
 * to `in_review` — either way a human has to look; a cancel hands the issue
 * back to `todo`. Pull requests among the run's artifacts are linked onto the
 * issue (`linkRunPullRequests`). Idempotent: an already-settled run returns `undefined` and
 * touches nothing.
 */
export async function settleIssueRunAndIssue(
  runId: string,
  settlement: SettleIssueRunInput,
  now = Date.now()
): Promise<IssueRun | undefined> {
  const settled = await settleIssueRun(runId, settlement, now)
  if (!settled) return undefined
  const actor = runtimeActorFor(settled)
  // A PR the run opened belongs on the issue even when its text never names
  // the issue; that is what lets an until-pr wakeup see it merge.
  await linkRunPullRequests(settled.issueId, settled.artifacts, actor)
  if (settled.status === "cancelled") {
    await applyRuntimeIssueStatus(settled.issueId, "todo", actor)
  } else {
    await applyRuntimeIssueStatus(settled.issueId, "in_review", actor)
  }
  return settled
}

export interface ReconcileIssueRunsResult {
  polled: number
  settled: string[]
  /** Runs whose adapter threw during `poll`; left active for the next pass. */
  errored: Array<{ runId: string; error: unknown }>
}

/**
 * Poll every active run through its adapter and settle the terminal ones. A
 * run whose adapter is no longer registered is settled as failed — an engine
 * we cannot ask cannot keep owning an `in_progress` column forever.
 */
export async function reconcileIssueRuns(
  registry: IssueRunRegistry = getIssueRunRegistry(),
  now = Date.now()
): Promise<ReconcileIssueRunsResult> {
  const active = await listIssueRuns({ activeOnly: true })
  const result: ReconcileIssueRunsResult = { polled: active.length, settled: [], errored: [] }
  for (const run of active) {
    const adapter = registry.get(run.adapterId)
    if (!adapter) {
      await settleIssueRunAndIssue(
        run.id,
        { status: "failed", error: `run adapter "${run.adapterId}" is not registered` },
        now
      )
      result.settled.push(run.id)
      continue
    }
    try {
      const outcome = await adapter.poll(run)
      if (outcome) {
        await settleIssueRunAndIssue(run.id, outcome, now)
        result.settled.push(run.id)
      }
    } catch (error) {
      result.errored.push({ runId: run.id, error })
    }
  }
  return result
}

/**
 * User-initiated cancel: best-effort engine cancel, then settle as cancelled.
 * Returns the settled run, or `undefined` if it was already terminal/missing.
 */
export async function cancelIssueRun(
  runId: string,
  registry: IssueRunRegistry = getIssueRunRegistry(),
  now = Date.now()
): Promise<IssueRun | undefined> {
  const run = await getIssueRun(runId)
  if (!run) return undefined
  const adapter = registry.get(run.adapterId)
  if (adapter?.cancel) await adapter.cancel(run)
  return settleIssueRunAndIssue(runId, { status: "cancelled" }, now)
}

/**
 * Sessions the run is executing in, newest first, or `[]` when it is not
 * active or its adapter cannot say (`IssueRunAdapter.sessionIds`).
 */
export async function issueRunSessionIds(
  run: IssueRun,
  registry: IssueRunRegistry = getIssueRunRegistry()
): Promise<string[]> {
  if (!isActiveIssueRunStatus(run.status)) return []
  const adapter = registry.get(run.adapterId)
  if (!adapter?.sessionIds) return []
  return adapter.sessionIds(run)
}

export interface SteerIssueRunDeps {
  registry?: IssueRunRegistry
  /** Defaults to `steerSession` in `lib/claude/ipc`, which runs its own PII gate. */
  steer?: (sessionId: string, text: string) => Promise<unknown>
}

/**
 * Deliver `text` into an active run's live session. Resolves `true` when the
 * session acknowledged it, `false` when the run has no steerable session or
 * the steer was refused (provider without a live-input lane, PII gate, the
 * turn already closed its input). Never throws for a refusal: the caller has
 * a fallback, and a refusal is the ordinary case for two of three engines.
 */
export async function steerIssueRun(
  run: IssueRun,
  text: string,
  deps: SteerIssueRunDeps = {}
): Promise<boolean> {
  const sessions = await issueRunSessionIds(run, deps.registry)
  const sessionId = sessions[0]
  if (!sessionId) return false
  const steer =
    deps.steer ??
    (async (id: string, prompt: string) => {
      const { steerSession } = await import("@/lib/claude/ipc")
      return steerSession(id, prompt)
    })
  try {
    await steer(sessionId, text)
    return true
  } catch {
    return false
  }
}

export type CheckInIssueRunResult =
  | { status: "checked-in"; run: IssueRun }
  | { status: "refused"; reason: "not-found" | "not-active" | "not-periodic-wakeup" }

/**
 * Settle a periodic wakeup's run with a note and leave the issue where it was.
 *
 * Starting the run moved the issue to `in_progress`; a check-in delivered
 * nothing to review, so instead of `settleIssueRunAndIssue`'s advance to
 * `in_review` the issue goes back to the open column it was in
 * (`IssueRunWakeup.statusBefore`). `applyRuntimeIssueStatus` only hands back
 * from `in_progress`, so an issue a person moved meanwhile stays where they
 * put it. The engine keeps running until its turn ends; its later terminal
 * poll finds the run already settled and changes nothing.
 *
 * Who may call this is the caller's question (`issue.wakeup_checkin` checks
 * the calling session is the run's own).
 */
export async function checkInIssueRun(
  runId: string,
  note: string,
  now = Date.now()
): Promise<CheckInIssueRunResult> {
  const run = await getIssueRun(runId)
  if (!run) return { status: "refused", reason: "not-found" }
  if (!isActiveIssueRunStatus(run.status)) return { status: "refused", reason: "not-active" }
  if (!run.wakeup?.periodic) return { status: "refused", reason: "not-periodic-wakeup" }
  const settled = await settleIssueRun(runId, { status: "succeeded", mode: "checkin", note }, now)
  if (!settled) return { status: "refused", reason: "not-active" }
  const before = run.wakeup.statusBefore
  if (before === "backlog" || before === "todo" || before === "in_review") {
    await applyRuntimeIssueStatus(settled.issueId, before, runtimeActorFor(settled))
  }
  return { status: "checked-in", run: settled }
}
