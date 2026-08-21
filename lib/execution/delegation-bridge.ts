/**
 * Project a delegation's children onto the delegation itself.
 *
 * One delegation is one card. Without this, every engine run a delegation
 * spawns would open its own binding and the person who asked one question
 * would be watching three cards drift apart — which is precisely the failure
 * mode "hand this off" was supposed to remove.
 *
 * Shaped as a RECONCILER rather than an event subscription, and that is the
 * load-bearing choice. A subscription only sees transitions it was alive for;
 * a delegation outlives page reloads, host switches, and crashes by design, so
 * the bridge has to be able to derive the parent's journal from the children's
 * CURRENT rows at any moment. Every emission carries a `sourceEventId` keyed by
 * `(child, state)`, so re-running is a no-op — replay safety comes from the
 * journal's own idempotency, not from remembering what we already sent.
 */

import Dexie from "dexie"

import {
  getExecutionRun,
  listChildExecutionRuns,
  listExecutionRuns,
  listExecutionRunEvents,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { safeStableActivityId } from "@/lib/execution/run-activity"
import type { ExecutionRun, ExecutionRunStatus, RunEventType } from "@/types/execution/run"

import { settleDelegation } from "./delegation"

const TERMINAL: ReadonlySet<ExecutionRunStatus> = new Set<ExecutionRunStatus>([
  "completed",
  "failed",
  "cancelled",
])

export const DELEGATION_RECONCILE_INTERVAL_MS = 60_000
const RECONCILE_DEBOUNCE_MS = 400

/** Milestone id for a child run — stable, opaque, and safe to render. */
export function delegationStepId(childRunId: string): string {
  return safeStableActivityId(`child-${childRunId}`)
}

function childEventType(status: ExecutionRunStatus): RunEventType {
  switch (status) {
    case "queued":
      return "step.added"
    case "completed":
      return "step.completed"
    case "failed":
      return "step.failed"
    case "cancelled":
      return "step.skipped"
    default:
      // running / waiting / paused / recovery_required are all "this milestone
      // is the one being worked on". Their nuance belongs to the child's own
      // card, not to the parent's milestone list.
      return "step.started"
  }
}

/**
 * Bring the delegation's milestone list level with its children.
 *
 * Emits at most one event per child per state, and only forward: a child that
 * is already `completed` on the parent does not go back to `in_progress`
 * because a stale row was read late.
 */
export async function syncDelegationChildren(delegationRunId: string): Promise<number> {
  const parent = await getExecutionRun(delegationRunId)
  if (!parent || parent.kind !== "delegation" || TERMINAL.has(parent.status)) return 0

  const children = await listChildExecutionRuns(delegationRunId)
  let emitted = 0
  // Oldest first so the milestone order on the card matches the order the work
  // was actually taken on.
  for (const child of [...children].sort((left, right) => left.startedAt - right.startedAt)) {
    const stepId = delegationStepId(child.id)
    const type = childEventType(child.status)
    try {
      await runEventJournal.append(
        delegationRunId,
        semanticRunEvent(
          type,
          {
            stepId,
            title: child.title,
            safeTitle: true,
            childRunId: child.id,
            childKind: child.kind,
          },
          { sourceEventId: `delegation-child:${child.id}:${child.status}` }
        )
      )
      emitted += 1
    } catch {
      // The parent settled underneath us (or the row vanished). Nothing about
      // a child's progress justifies reopening a closed commitment.
      return emitted
    }
  }
  return emitted
}

/**
 * Decide whether a delegation is finished, and close it if so.
 *
 * Deliberately conservative. A delegation is NOT closed because its children
 * ran out: it is closed when nothing can still make progress AND nobody has
 * been asked a question. A delegation parked on a `human_handoff` has no
 * active children by construction — settling on "no active children" alone
 * would close every handoff the moment it was made.
 */
export async function maybeSettleDelegation(delegationRunId: string): Promise<boolean> {
  const parent = await getExecutionRun(delegationRunId)
  if (!parent || parent.kind !== "delegation" || TERMINAL.has(parent.status)) return false

  const pendingInterrupts = await getDb()
    .executionRunInterrupts.where("[runId+status]")
    .equals([delegationRunId, "pending"])
    .count()
  if (pendingInterrupts > 0) return false

  const children = await listChildExecutionRuns(delegationRunId)
  const stillWorking = children.some((child) => !TERMINAL.has(child.status))

  // A recorded `stop` is a withdrawn commitment, and it has to close the
  // delegation even when there was never a child to stop. The delegation
  // control handler cannot close it itself: settling appends a terminal event,
  // and the control gate must still append `control.accepted` afterwards — a
  // terminal journal refuses that, correctly. So the intent is read back from
  // the journal here, which is also what makes it survive a crash in between.
  if (!stillWorking && (await stopWasRequested(delegationRunId))) {
    await settleDelegation({ runId: delegationRunId, status: "cancelled" })
    return true
  }

  if (children.length === 0) return false
  if (stillWorking) return false

  // The latest attempt decides. An earlier failure followed by a successful
  // retry is a delegation that succeeded — the whole reason retry mints a new
  // child rather than reopening the failed one.
  const latest = children.reduce((newest, child) =>
    child.updatedAt >= newest.updatedAt ? child : newest
  )
  const status =
    latest.status === "completed"
      ? "completed"
      : latest.status === "failed"
        ? "failed"
        : "cancelled"
  await settleDelegation({ runId: delegationRunId, status })
  return true
}

/** True when someone already asked this delegation to stop. */
async function stopWasRequested(delegationRunId: string): Promise<boolean> {
  const events = await listExecutionRunEvents(delegationRunId)
  return events.some(
    (event) => event.type === "control.accepted" && event.payload.action === "stop"
  )
}

/** Every delegation that could still change. */
async function openDelegations(): Promise<ExecutionRun[]> {
  return listExecutionRuns({
    kinds: ["delegation"],
    statuses: ["queued", "running", "waiting", "paused", "recovery_required"],
    limit: 200,
  })
}

/**
 * Reconcile every open delegation.
 *
 * Called on a timer, on Dexie change, and once at startup — the same triad
 * `lib/issues/run/install.ts` uses, for the same reason: the interesting case
 * is the one where the process that would have watched the transition was not
 * running when it happened.
 */
export async function reconcileDelegationRuns(): Promise<{ synced: number; settled: number }> {
  const delegations = await openDelegations()
  let synced = 0
  let settled = 0
  for (const delegation of delegations) {
    synced += await syncDelegationChildren(delegation.id)
    if (await maybeSettleDelegation(delegation.id)) settled += 1
  }
  return { synced, settled }
}

export interface InstallDelegationBridgeOptions {
  intervalMs?: number
  onError?: (error: unknown) => void
  /** Off in tests that drive `reconcileDelegationRuns` directly. */
  subscribeDexie?: boolean
}

/**
 * Wire the reconciler to its three triggers and return the disposer.
 */
export function installDelegationBridge(options: InstallDelegationBridgeOptions = {}): () => void {
  let disposed = false
  let running: Promise<unknown> | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  const onError = options.onError ?? (() => undefined)

  const runReconcile = (): Promise<unknown> => {
    if (disposed) return Promise.resolve()
    // Serialize: a Dexie change fired BY the reconciler must not re-enter it.
    if (running) return running
    running = reconcileDelegationRuns()
      .catch(onError)
      .finally(() => {
        running = null
      })
    return running
  }

  const scheduleReconcile = () => {
    if (disposed) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void runReconcile()
    }, RECONCILE_DEBOUNCE_MS)
  }

  let unsubscribe: (() => void) | null = null
  if (options.subscribeDexie !== false) {
    try {
      // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build
      // makes `liveQuery` non-enumerable and SWC's wildcard interop drops it
      // the moment a module also imports the `Dexie` default.
      const subscription = Dexie.liveQuery(async () => {
        // Both halves matter: a child changing state is the usual trigger, and
        // the delegation itself changing is how a recorded `stop` (or a fresh
        // accept) reaches the reconciler in the same tick the user acted.
        const [children, delegations] = await Promise.all([
          getDb().executionRuns.where("parentRunId").notEqual("").toArray(),
          getDb().executionRuns.where("kind").equals("delegation").toArray(),
        ])
        return [...children, ...delegations]
          .map((row) => `${row.id}:${row.status}:${row.currentRevision}`)
          .join("|")
      }).subscribe({ next: () => scheduleReconcile(), error: onError })
      unsubscribe = () => subscription.unsubscribe()
    } catch (error) {
      onError(error)
    }
  }

  const interval = setInterval(
    () => void runReconcile(),
    options.intervalMs ?? DELEGATION_RECONCILE_INTERVAL_MS
  )
  // Reload recovery: settle whatever finished while we were away.
  void runReconcile()

  return () => {
    if (disposed) return
    disposed = true
    if (debounce) clearTimeout(debounce)
    clearInterval(interval)
    unsubscribe?.()
  }
}
