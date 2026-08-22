/**
 * Durable connector housekeeping clock.
 *
 * Three low-frequency sweeps used to own independent setTimeout/setInterval
 * loops. One persisted scheduler interval now emits a daily event; three
 * event-triggered tasks fan out through the scheduler's existing escape hatch.
 * This gives headless restart/catch-up semantics without moving sub-minute
 * liveness heartbeats into Dexie.
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
import type { CreateScheduledTaskInput, ScheduledTaskType } from "@/types/scheduler"

export const CONNECTOR_HOUSEKEEPING_EVENT = "connection:housekeeping:daily"
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
const HOUSEKEEPING_TAG = "system:connector-housekeeping"

const silentNotification: CreateScheduledTaskInput["notification"] = {
  onStart: false,
  onComplete: false,
  onError: true,
  onProgress: false,
  channels: ["none"],
}

function registerHousekeepingExecutors(): void {
  registerTaskExecutor(HOUSEKEEPING_CLOCK_TASK_TYPE, async (task) => {
    await getTaskScheduler().triggerEventTask(
      CONNECTOR_HOUSEKEEPING_EVENT,
      "connector-housekeeping-clock",
      { clockTaskId: task.id }
    )
    return { success: true, output: { eventType: CONNECTOR_HOUSEKEEPING_EVENT } }
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
  }
  return [
    {
      ...common,
      name: "Connector housekeeping clock",
      type: HOUSEKEEPING_CLOCK_TASK_TYPE,
      trigger: { type: "interval", intervalMs: DAILY_INTERVAL_MS },
      config: {
        runMissedOnStartup: true,
        catchupWindowMs: 7 * DAILY_INTERVAL_MS,
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
 * Register executors, ensure the persisted internal tasks exist, then
 * issue one boot sweep through the same event path. Safe to call repeatedly.
 */
export async function installConnectorHousekeepingSchedule(): Promise<void> {
  registerHousekeepingExecutors()
  const scheduler = getTaskScheduler()
  const existingTypes = new Set((await scheduler.getAllTasks()).map((task) => task.type))
  for (const draft of taskDrafts()) {
    if (!existingTypes.has(draft.type)) await scheduler.createTask(draft)
  }
  await scheduler.triggerEventTask(CONNECTOR_HOUSEKEEPING_EVENT, "connector-runtime-boot", {
    bootedAt: Date.now(),
  })
}
