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

import type { IssueActor, IssueRun, IssueRunKind } from "@/types/issues"
import { getIssue } from "@/lib/db/issues"
import { applyRuntimeIssueStatus } from "@/lib/db/issues"
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
  IssueRunOrigin,
  IssueRunRefusalReason,
  IssueRunTarget,
  IssueRunVerdict,
} from "./types"

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
  registry: IssueRunRegistry = getIssueRunRegistry()
): Promise<IssueRunOption[]> {
  const target = await loadIssueRunTarget(issueId)
  if (!target) return []
  const blanket = await trackerVerdict(target)
  const adapters = registry.list()
  return Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      verdict: blanket.ok ? await adapter.canRun(target) : blanket,
    }))
  )
}

async function trackerVerdict(target: IssueRunTarget): Promise<IssueRunVerdict> {
  const { issue } = target
  if (issue.statusCategory === "completed" || issue.statusCategory === "canceled") {
    return { ok: false, reason: "issue-finished" }
  }
  if (await hasActiveIssueRun(issue.id)) return { ok: false, reason: "run-active" }
  return { ok: true }
}

export interface StartIssueRunInput {
  issueId: string
  adapterId: string
  by: IssueActor
  origin: IssueRunOrigin
  options?: Readonly<Record<string, unknown>>
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

  const blanket = await trackerVerdict(target)
  if (!blanket.ok) throw new IssueRunRefusedError(blanket.reason, blanket.detail)
  const verdict = await adapter.canRun(target)
  if (!verdict.ok) throw new IssueRunRefusedError(verdict.reason, verdict.detail)

  const run = await adapter.start(target, {
    by: input.by,
    origin: input.origin,
    ...(input.options ? { options: input.options } : {}),
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
 * back to `todo`. Idempotent: an already-settled run returns `undefined` and
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
