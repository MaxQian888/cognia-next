/**
 * Issue trail → scheduler events, for issue wakeups.
 *
 * Subscribes `lib/issues/event-bus.ts` and publishes each entry as one
 * `issue:activity` scheduler event on `eventSource: "issue:<id>"`, so every
 * wakeup rule is an ordinary event-triggered task and the scheduler's
 * `[status+eventType]` index does the matching. Per entry it also:
 *
 *   - attributes the entry to the run that caused it (`attributeIssueEvent`)
 *     and forwards that run's wakeup lineage, which is what lets the fire
 *     gate suppress a rule's own echo and the executor see a loop;
 *   - publishes a derived `child_status_changed` / `child_stage_changed` on
 *     the PARENT's source, so a "wait for my sub-issues" rule watches one
 *     source however many children come and go;
 *   - pauses the issue's own wakeups when it finishes (reopening does not
 *     resume them), and ensures the parent's platform rule when an issue
 *     gains a parent.
 *
 * Entries are handled one at a time on a macrotask, after the writer's Dexie
 * transaction: the bus publishes from inside it, and reads of other tables
 * made in that zone would fail as "not part of transaction". One at a time
 * also keeps a burst in order, which the chain relies on.
 *
 * Before publishing, the bridge asks whether any active rule listens on the
 * issue (or its parent) at all, so an install with no wakeups pays two cheap
 * reads per trail entry (the issue row, the indexed listener lookup).
 */

import type {
  IssueActivityEventData,
  IssueEvent,
  IssueRun,
  IssueWakeupEventKind,
} from "@/types/issues"
import {
  ISSUE_ACTIVITY_EVENT,
  ISSUE_WAKEUP_TASK_TYPE,
  issueWakeupEventSource,
} from "@/types/issues"
import { onIssueEvent } from "@/lib/issues/event-bus"
import {
  actorOfPayload,
  attributeIssueEvent,
  isTerminalIssueStatus,
  summarizeIssueEventPayload,
} from "./model"

/** Child trail kinds re-published on the parent's source, as their derived kind. */
const CHILD_KINDS: Partial<Record<string, IssueWakeupEventKind>> = {
  status_changed: "child_status_changed",
  stage_changed: "child_stage_changed",
}

/** Trail kinds that are records of a delivery, never inputs to another rule. */
const NOT_PUBLISHED: ReadonlySet<string> = new Set(["wakeup_fired"])

export interface IssueWakeupBridgeDeps {
  /** Sources that at least one active `issue:activity` task listens on. */
  listenedSources: () => Promise<Set<string>>
  publish: (data: IssueActivityEventData, source: string) => Promise<void>
  getIssue: (id: string) => Promise<import("@/types/issues").Issue | undefined>
  listRuns: (issueId: string) => Promise<IssueRun[]>
  pauseWakeupsForIssue: (issueId: string) => Promise<unknown>
  ensureChildrenDoneWakeup: (parentId: string) => Promise<unknown>
  /** Defers a drain. Tests pass a synchronous one. */
  schedule: (fn: () => void) => void
  onError: (error: unknown) => void
}

async function defaultListenedSources(): Promise<Set<string>> {
  const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
  const tasks = await schedulerDb.getActiveEventTasks(ISSUE_ACTIVITY_EVENT)
  const sources = new Set<string>()
  for (const task of tasks) {
    if (task.type !== ISSUE_WAKEUP_TASK_TYPE) {
      // A non-wakeup task listening on every issue (no source filter).
      if (!task.trigger.eventSource) sources.add("*")
      else sources.add(task.trigger.eventSource)
      continue
    }
    if (task.trigger.eventSource) sources.add(task.trigger.eventSource)
  }
  return sources
}

function defaultDeps(onError: (error: unknown) => void): IssueWakeupBridgeDeps {
  return {
    listenedSources: defaultListenedSources,
    publish: async (data, source) => {
      const { emitSchedulerEvent } = await import("@/lib/scheduler/event-integration")
      await emitSchedulerEvent(ISSUE_ACTIVITY_EVENT, data, source)
    },
    getIssue: async (id) => (await import("@/lib/db/issues")).getIssue(id),
    listRuns: async (issueId) => (await import("@/lib/db/issue-runs")).listIssueRuns({ issueId }),
    pauseWakeupsForIssue: async (issueId) =>
      (await import("./service")).pauseWakeupsForIssue(issueId),
    ensureChildrenDoneWakeup: async (parentId) =>
      (await import("./service")).ensureChildrenDoneWakeup(parentId),
    schedule: (fn) => setTimeout(fn, 0),
    onError,
  }
}

/** The activity data one trail entry publishes on its own issue's source. */
export function buildActivityData(
  event: IssueEvent,
  run: IssueRun | undefined
): IssueActivityEventData {
  const payload = event.payload
  const actor = actorOfPayload(payload)
  const transition =
    payload.kind === "status_changed"
      ? { from: payload.from, to: payload.to }
      : payload.kind === "stage_changed"
        ? { fromStage: payload.from ?? null, toStage: payload.to ?? null }
        : payload.kind === "triage_changed"
          ? { triageTo: payload.to ?? null }
          : payload.kind === "pr_state_changed"
            ? { prTo: payload.to }
            : {}
  // A person acting resets the chain: a revisit after a human is legitimate.
  const chain = actor?.kind === "human" ? [] : (run?.wakeup?.chain ?? [])
  return {
    issueId: event.issueId,
    subjectId: event.issueId,
    kind: event.kind,
    eventId: event.id,
    ts: event.ts,
    ...(actor ? { actor } : {}),
    ...transition,
    ...(run ? { runId: run.id } : {}),
    ...(run?.wakeup ? { originTaskId: run.wakeup.taskId } : {}),
    chain: [...chain],
    summary: summarizeIssueEventPayload(payload),
  }
}

/** Handle one trail entry. Exported for tests; the installer queues these. */
export async function relayIssueEvent(
  event: IssueEvent,
  deps: IssueWakeupBridgeDeps
): Promise<void> {
  if (NOT_PUBLISHED.has(event.kind)) return
  const payload = event.payload

  if (payload.kind === "status_changed" && isTerminalIssueStatus(payload.to)) {
    await deps.pauseWakeupsForIssue(event.issueId)
  }

  const issue = await deps.getIssue(event.issueId)
  // Plan Phase 1: an issue that gains a parent gives the parent its
  // children-done rule. `created` covers a child filed with its parent set.
  const newParent =
    payload.kind === "parent_changed"
      ? payload.to
      : payload.kind === "created"
        ? issue?.parentId
        : undefined
  if (newParent) await deps.ensureChildrenDoneWakeup(newParent)

  const sources = await deps.listenedSources()
  const ownSource = issueWakeupEventSource(event.issueId)
  const childKind = CHILD_KINDS[payload.kind]
  const parentId = childKind ? issue?.parentId : undefined
  const parentSource = parentId ? issueWakeupEventSource(parentId) : undefined
  const ownListened = sources.has("*") || sources.has(ownSource)
  const parentListened = parentSource ? sources.has("*") || sources.has(parentSource) : false
  if (!ownListened && !parentListened) return

  const runs = await deps.listRuns(event.issueId)
  const run = attributeIssueEvent(event, runs, issue?.assignee)
  const data = buildActivityData(event, run)

  if (ownListened) await deps.publish(data, ownSource)
  if (parentListened && parentId && parentSource && childKind) {
    await deps.publish({ ...data, issueId: parentId, kind: childKind }, parentSource)
  }
}

let installed: (() => void) | null = null

/** Subscribe the bus. Idempotent; returns the disposer. */
export function installIssueWakeupBridge(
  options: { onError?: (error: unknown) => void; deps?: Partial<IssueWakeupBridgeDeps> } = {}
): () => void {
  if (installed) return installed
  const onError = options.onError ?? (() => {})
  const deps: IssueWakeupBridgeDeps = { ...defaultDeps(onError), ...options.deps }
  const queue: IssueEvent[] = []
  let draining = false
  let disposed = false

  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (!disposed && queue.length > 0) {
        const event = queue.shift()!
        try {
          await relayIssueEvent(event, deps)
        } catch (error) {
          deps.onError(error)
        }
      }
    } finally {
      draining = false
    }
  }

  const unsubscribe = onIssueEvent((event) => {
    if (disposed) return
    queue.push(event)
    if (!draining) deps.schedule(() => void drain())
  })

  const dispose = () => {
    if (disposed) return
    disposed = true
    queue.length = 0
    unsubscribe()
    installed = null
  }
  installed = dispose
  return dispose
}
