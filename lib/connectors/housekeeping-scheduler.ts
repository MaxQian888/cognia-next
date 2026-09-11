/**
 * Durable connector housekeeping clock.
 *
 * Three low-frequency sweeps used to own independent setTimeout/setInterval
 * loops. One persisted scheduler interval now emits a daily event, and three
 * event-triggered tasks fan out through the scheduler's existing escape hatch.
 * This gives headless restart/catch-up semantics without moving sub-minute
 * liveness heartbeats into Dexie.
 *
 * That fan-out is the widest on the host (one clock plus five sweeps), and
 * since `lib/scheduler/concurrency-limit.ts` made `maxConcurrentExecutions`
 * real it is measured against a default ceiling of 5. Two consequences shape
 * everything below.
 *
 * 1. The clock holds an execution slot while it relays the event, so the
 *    clock-driven sweep is 6 starts against 5 slots. Under the inherited
 *    `skip` policy the loser was DROPPED rather than delayed, because
 *    `concurrency-blocked` is terminal, there is no retry, and the next chance
 *    was 24 h later where the same task lost again (the event fan-out reads a
 *    Dexie index, so the order is stable per install). Every housekeeping task
 *    therefore declares `queue-one`: a start that cannot take a slot is
 *    buffered, and `drainOneBufferedStart` releases it as soon as one frees.
 * 2. Two independent things want to sweep at boot: this module's own boot
 *    sweep, and the clock's `runMissedOnStartup` catch-up. Firing both puts
 *    two bursts of five starts against the cap inside one startup window. Both
 *    now go through `dispatchHousekeepingSweep`, which collapses them.
 */

import { cleanupExpiredCallbackBindings } from "./callback-binding-cleanup"
import { sweepExecutionRunEventRetention } from "@/lib/db/execution-runs"
import { sweepTerminalOutboundRows } from "@/lib/db/outbound-jobs"
import { sweepTerminalConnectorInboundJobs } from "@/lib/db/connector-inbound-jobs"
import { sweepConnectorAuditRetention } from "@/lib/db/connector-audit"
import { sweepConnectorHeartbeats } from "@/lib/connectors/health/heartbeat"
import {
  enforceAttachmentBudget,
  reconcileOrphanedAttachments,
  runCleanupLedger,
} from "@/lib/connectors/attachment-fetcher"
import { getTaskScheduler, registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import { resolveOverlapPolicy } from "@/lib/scheduler/runtime-policy"
import type {
  CreateScheduledTaskInput,
  ScheduledTaskType,
  TaskExecutionConfig,
  TaskOverlapPolicy,
} from "@/types/scheduler"

export const CONNECTOR_HOUSEKEEPING_EVENT = "connection:housekeeping:daily"
/** Event source recorded for the sweep issued when the runtime installs. */
export const CONNECTOR_HOUSEKEEPING_BOOT_SOURCE = "connector-runtime-boot"
/** Event source recorded for the sweep the daily clock relays. */
export const CONNECTOR_HOUSEKEEPING_CLOCK_SOURCE = "connector-housekeeping-clock"
export const HOUSEKEEPING_CLOCK_TASK_TYPE =
  "connection:housekeeping:clock" satisfies ScheduledTaskType
export const OUTBOUND_RETENTION_TASK_TYPE =
  "connection:housekeeping:outbound-retention" satisfies ScheduledTaskType
export const CALLBACK_BINDING_CLEANUP_TASK_TYPE =
  "connection:housekeeping:callback-bindings" satisfies ScheduledTaskType
export const EXECUTION_RUN_RETENTION_TASK_TYPE =
  "connection:housekeeping:execution-runs" satisfies ScheduledTaskType
export const CONNECTOR_RETENTION_TASK_TYPE =
  "connection:housekeeping:connector-retention" satisfies ScheduledTaskType
export const ATTACHMENT_CACHE_TASK_TYPE =
  "connection:housekeeping:attachment-cache" satisfies ScheduledTaskType

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1_000
const CATCHUP_WINDOW_MS = 7 * DAILY_INTERVAL_MS
const HOUSEKEEPING_TAG = "system:connector-housekeeping"

/**
 * Every housekeeping task buffers a start it cannot take instead of losing it.
 *
 * `queue-one` rather than `queue-all` because these sweeps are idempotent
 * retention deletes: two pending copies of "delete what has expired" are worth
 * exactly one, and "newest wins" means a duplicate trigger can never build a
 * backlog. The one thing that must not happen, and the thing that was
 * happening, is a sweep dropped because something else held the slot.
 */
export const HOUSEKEEPING_OVERLAP_POLICY: TaskOverlapPolicy = "queue-one"

/**
 * How close together two sweep dispatches have to be before the second is
 * treated as the same sweep.
 *
 * Deliberately far longer than a startup window and far shorter than the daily
 * cadence, so it can only ever collapse the boot/catch-up pair it exists for.
 * Process-local on purpose: the collision is always inside one process's
 * startup, and a restart genuinely should sweep again.
 */
export const HOUSEKEEPING_SWEEP_DEBOUNCE_MS = 5 * 60_000

let lastSweepDispatchedAtMs = 0

/** Test seam: clears the process-local dispatch debounce. */
export function __resetHousekeepingSweepDebounceForTests(): void {
  lastSweepDispatchedAtMs = 0
}

/**
 * The single door every housekeeping sweep goes through.
 *
 * Returns whether the event was actually relayed, so a caller (and the clock
 * task's run record) can tell "swept" from "a sweep was already in flight".
 * `force` exists for an operator pressing Run now on the clock: an explicit
 * manual sweep must never be swallowed by a debounce meant for boot races.
 */
export async function dispatchHousekeepingSweep(
  eventSource: string,
  payload: Record<string, unknown>,
  options: { force?: boolean } = {}
): Promise<boolean> {
  const now = Date.now()
  if (
    !options.force &&
    lastSweepDispatchedAtMs > 0 &&
    now - lastSweepDispatchedAtMs < HOUSEKEEPING_SWEEP_DEBOUNCE_MS
  ) {
    return false
  }
  // Armed before the await so a second dispatch racing this one is collapsed,
  // and rolled back on failure: a dispatch that never reached the scheduler
  // must not stand in for the sweep it failed to start, or the clock's
  // catch-up is suppressed too and this boot sweeps nothing at all.
  const previous = lastSweepDispatchedAtMs
  lastSweepDispatchedAtMs = now
  try {
    await getTaskScheduler().triggerEventTask(CONNECTOR_HOUSEKEEPING_EVENT, eventSource, payload)
  } catch (error) {
    lastSweepDispatchedAtMs = previous
    throw error
  }
  return true
}

const silentNotification: CreateScheduledTaskInput["notification"] = {
  onStart: false,
  onComplete: false,
  onError: true,
  onProgress: false,
  channels: ["none"],
}

function registerHousekeepingExecutors(): void {
  registerTaskExecutor(HOUSEKEEPING_CLOCK_TASK_TYPE, async (task, execution) => {
    const dispatched = await dispatchHousekeepingSweep(
      CONNECTOR_HOUSEKEEPING_CLOCK_SOURCE,
      { clockTaskId: task.id },
      { force: execution.triggerSource === "run-now" }
    )
    return { success: true, output: { eventType: CONNECTOR_HOUSEKEEPING_EVENT, dispatched } }
  })
  registerTaskExecutor(OUTBOUND_RETENTION_TASK_TYPE, async () => ({
    success: true,
    output: { deleted: await sweepTerminalOutboundRows() },
  }))
  registerTaskExecutor(CALLBACK_BINDING_CLEANUP_TASK_TYPE, async () => {
    const result = await cleanupExpiredCallbackBindings()
    return { success: true, output: { ...result } }
  })
  registerTaskExecutor(EXECUTION_RUN_RETENTION_TASK_TYPE, async () => ({
    success: true,
    output: { deleted: await sweepExecutionRunEventRetention() },
  }))
  // Attachment cache upkeep, in dependency order: retry blobs whose delete
  // never landed, drop ciphertext no row claims any more, then enforce the
  // size ceiling. Running the ledger first means a blob that finally deletes
  // is not counted against the budget and evicted twice.
  registerTaskExecutor(ATTACHMENT_CACHE_TASK_TYPE, async () => {
    const ledger = await runCleanupLedger()
    const orphans = await reconcileOrphanedAttachments()
    const budget = await enforceAttachmentBudget()
    return {
      success: true,
      output: {
        ledgerResolved: ledger.resolved,
        ledgerStillFailing: ledger.stillFailing,
        orphansDeleted: orphans.deleted.length,
        orphanBytesFreed: orphans.freedBytes,
        evicted: budget.deleted.length,
        evictedBytesFreed: budget.freedBytes,
      },
    }
  })
  registerTaskExecutor(CONNECTOR_RETENTION_TASK_TYPE, async () => ({
    success: true,
    output: {
      inboundDeleted: await sweepTerminalConnectorInboundJobs(),
      auditDeleted: await sweepConnectorAuditRetention(),
      heartbeatDeleted: await sweepConnectorHeartbeats(),
    },
  }))
}

function taskDrafts(): CreateScheduledTaskInput[] {
  const common = {
    notification: silentNotification,
    createdBy: { kind: "user" as const },
    tags: [HOUSEKEEPING_TAG],
    config: { overlapPolicy: HOUSEKEEPING_OVERLAP_POLICY },
  }
  return [
    {
      ...common,
      name: "Connector housekeeping clock",
      type: HOUSEKEEPING_CLOCK_TASK_TYPE,
      trigger: { type: "interval", intervalMs: DAILY_INTERVAL_MS },
      config: {
        ...common.config,
        runMissedOnStartup: true,
        catchupWindowMs: CATCHUP_WINDOW_MS,
        maxMissedRuns: 1,
      },
    },
    {
      ...common,
      name: "Connector outbound retention",
      type: OUTBOUND_RETENTION_TASK_TYPE,
      trigger: { type: "event", eventType: CONNECTOR_HOUSEKEEPING_EVENT },
    },
    {
      ...common,
      name: "Connector callback binding cleanup",
      type: CALLBACK_BINDING_CLEANUP_TASK_TYPE,
      trigger: { type: "event", eventType: CONNECTOR_HOUSEKEEPING_EVENT },
    },
    {
      ...common,
      name: "Connector execution-run retention",
      type: EXECUTION_RUN_RETENTION_TASK_TYPE,
      trigger: { type: "event", eventType: CONNECTOR_HOUSEKEEPING_EVENT },
    },
    {
      ...common,
      name: "Connector inbound, audit and heartbeat retention",
      type: CONNECTOR_RETENTION_TASK_TYPE,
      trigger: { type: "event", eventType: CONNECTOR_HOUSEKEEPING_EVENT },
    },
    {
      ...common,
      name: "Connector attachment cache upkeep",
      type: ATTACHMENT_CACHE_TASK_TYPE,
      trigger: { type: "event", eventType: CONNECTOR_HOUSEKEEPING_EVENT },
    },
  ]
}

/**
 * The overlap policy a persisted housekeeping row is missing, or `undefined`
 * when it already buffers.
 *
 * A fix in `taskDrafts` alone would be dormant everywhere it matters: the
 * installer only creates types it does not find, so every host that already
 * has these six rows would keep dropping starts forever. Reconciliation is the
 * half that reaches an existing install.
 *
 * A row that already names some queueing policy is left alone, so an operator
 * who chose `queue-all` keeps it. Only `skip` and `allow` count as drift,
 * including the legacy `allowConcurrent` spelling, which is why this reads
 * through `resolveOverlapPolicy` rather than the raw field.
 */
export function housekeepingOverlapDrift(
  config: TaskExecutionConfig | undefined
): TaskOverlapPolicy | undefined {
  const current = config ? resolveOverlapPolicy(config) : undefined
  if (current === "queue-one" || current === "queue-all") return undefined
  return HOUSEKEEPING_OVERLAP_POLICY
}

/**
 * Register executors, ensure the persisted internal tasks exist and still
 * carry the policy they depend on, then issue one boot sweep through the same
 * event path. Safe to call repeatedly.
 */
export async function installConnectorHousekeepingSchedule(): Promise<void> {
  registerHousekeepingExecutors()
  const scheduler = getTaskScheduler()
  const existingByType = new Map((await scheduler.getAllTasks()).map((task) => [task.type, task]))
  for (const draft of taskDrafts()) {
    const existing = existingByType.get(draft.type)
    if (!existing) {
      await scheduler.createTask(draft)
      continue
    }
    const overlapPolicy = housekeepingOverlapDrift(existing.config)
    if (overlapPolicy) {
      await scheduler.updateTask(existing.id, { config: { overlapPolicy } })
    }
  }
  await dispatchHousekeepingSweep(CONNECTOR_HOUSEKEEPING_BOOT_SOURCE, { bootedAt: Date.now() })
}
