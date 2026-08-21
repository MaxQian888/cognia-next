/**
 * Boot wiring for the run bridge — the part the `wiring-auditor` exists for.
 *
 * `installIssueRunBridge()` registers the three adapters and starts the
 * watchers that turn engine-side state changes into `poll` calls:
 *   - a Dexie `liveQuery` over the AgentTask rows and integration jobs the
 *     active runs point at (fires on any status/revision change),
 *   - a subscription on the AgentTeam store (tasks / team status),
 *   - a slow safety interval and one reconcile at boot (the reload-recovery
 *     path — the adapters' in-flight promises are gone after a reload, the
 *     engine rows are not).
 *
 * Idempotent: a second call returns the same disposer. Called from
 * `bootIssueTracker` (`components/providers/initializers/issue-tracker-initializer.tsx`).
 */

import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import { listIssueRuns } from "@/lib/db/issue-runs"
import { createAgentTaskRunAdapter } from "./agent-task-adapter"
import { createAgentTeamRunAdapter, ensureAgentTeamStoreLoaded } from "./agent-team-adapter"
import { createGithubLoopRunAdapter } from "./github-loop-adapter"
import { getIssueRunRegistry, reconcileIssueRuns, type IssueRunRegistry } from "./registry"

export const ISSUE_RUN_RECONCILE_INTERVAL_MS = 60_000
const RECONCILE_DEBOUNCE_MS = 200

export interface InstallIssueRunBridgeOptions {
  registry?: IssueRunRegistry
  /** Test injection: skip the store subscription (no zustand store in the harness). */
  subscribeTeamStore?: boolean
  intervalMs?: number
  onError?: (error: unknown) => void
}

let installed: { dispose: () => void } | null = null

/**
 * A change signature over the engine rows the active runs point at. `liveQuery`
 * tracks every table range this reads, so any write to those rows (or to
 * `issueRuns`) re-emits — that is the whole trick.
 */
export async function engineChangeSignature(): Promise<string> {
  const runs = await listIssueRuns({ activeOnly: true })
  const db = getDb()
  const taskIds = runs.filter((run) => run.kind === "agent-task").map((run) => run.targetId)
  const jobIds = runs.filter((run) => run.kind === "github-loop").map((run) => run.targetId)
  const [tasks, jobs] = await Promise.all([
    taskIds.length ? db.agentTasks.where("id").anyOf(taskIds).toArray() : Promise.resolve([]),
    jobIds.length
      ? db.integrationActionJobs.where("id").anyOf(jobIds).toArray()
      : Promise.resolve([]),
  ])
  return [
    `runs:${runs.length}`,
    ...tasks.map((task) => `task:${task.id}:${task.status}:${task.revision}`),
    ...jobs.map((job) => `job:${job.id}:${job.status}`),
  ].join("|")
}

export function installIssueRunBridge(options: InstallIssueRunBridgeOptions = {}): () => void {
  if (installed) return installed.dispose
  const registry = options.registry ?? getIssueRunRegistry()
  const onError = options.onError ?? (() => {})

  registry.register(createAgentTaskRunAdapter())
  registry.register(createAgentTeamRunAdapter())
  registry.register(createGithubLoopRunAdapter())

  let disposed = false
  let debounce: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let rerun = false

  const runReconcile = (): Promise<void> => {
    if (running) {
      rerun = true
      return running
    }
    running = reconcileIssueRuns(registry)
      .then(() => undefined)
      .catch(onError)
      .finally(() => {
        running = null
        if (rerun && !disposed) {
          rerun = false
          void runReconcile()
        }
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

  // Engine tables (Dexie).
  let unsubscribeLive: (() => void) | null = null
  try {
    // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
    // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
    // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
    const subscription = Dexie.liveQuery(engineChangeSignature).subscribe({
      next: () => scheduleReconcile(),
      error: onError,
    })
    unsubscribeLive = () => subscription.unsubscribe()
  } catch (error) {
    onError(error)
  }

  // AgentTeam store (zustand, not Dexie).
  let unsubscribeStore: (() => void) | null = null
  if (options.subscribeTeamStore !== false) {
    void ensureAgentTeamStoreLoaded()
      .then((store) => {
        if (disposed) return
        unsubscribeStore = store.subscribe((state, previous) => {
          if (state.tasks !== previous.tasks || state.teams !== previous.teams) scheduleReconcile()
        })
      })
      .catch(onError)
  }

  const interval = setInterval(
    () => void runReconcile(),
    options.intervalMs ?? ISSUE_RUN_RECONCILE_INTERVAL_MS
  )
  // Reload recovery: settle whatever finished while we were away.
  void runReconcile()

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (debounce) clearTimeout(debounce)
    clearInterval(interval)
    unsubscribeLive?.()
    unsubscribeStore?.()
    installed = null
  }
  installed = { dispose }
  return dispose
}

/** Test-only. */
export function __resetIssueRunBridgeForTesting(): void {
  installed?.dispose()
  installed = null
}
