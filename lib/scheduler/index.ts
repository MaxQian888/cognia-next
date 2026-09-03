/**
 * Scheduler module barrel — public surface used by hooks/UI/store.
 *
 * Executor coverage and per-host support are declared in
 * `./host-support.ts` (`TASK_TYPE_HOST_REQUIREMENTS`, `DEPRECATED_TASK_TYPES`);
 * `./executors/index.ts` registers the built-in executors and lists them.
 */

import { loggers } from "@cognia/logging"
import { initTaskScheduler, stopTaskScheduler } from "./task-scheduler"
import { registerBuiltInExecutors } from "./executors"
import type { SchedulerTimingDriver } from "@/types/scheduler"

const log = loggers.scheduler

// Core scheduler
export {
  getTaskScheduler,
  createTaskScheduler,
  initTaskScheduler,
  stopTaskScheduler,
  registerTaskExecutor,
  unregisterTaskExecutor,
  hasTaskExecutor,
  type ExecutionStatusEvent,
} from "./task-scheduler"

// Cron parser utilities
export {
  parseCronExpression,
  validateCronExpression,
  getNextCronTime,
  getNextCronTimes,
  describeCronExpression,
  formatCronExpression,
  matchesCronExpression,
} from "./cron-parser"

// Backfill (slot enumeration is reused by the UI preview)
export { enumerateBackfillSlots, BACKFILL_MAX_SLOTS } from "./backfill"

// Runtime policy helpers
export {
  resolveOverlapPolicy,
  applyJitter,
  isPastEndAt,
  isAtMaxRuns,
  isSlotOutsideCatchupWindow,
} from "./runtime-policy"

// Trigger normalization and validation
export { normalizeTaskTrigger, isValidTimezone } from "./trigger-normalizer"
export {
  createScheduledAgentTaskDraft,
  createScheduledChatTaskDraft,
  normalizeConversationalTaskPayload,
  type ConversationalTaskDraft,
} from "./conversational-task-authoring"

// Database
export { schedulerDb, SchedulerDatabase } from "./scheduler-db"

// Notifications
export { notifyTaskEvent, testNotificationChannel } from "./notification-integration"

// Executors
export {
  registerBuiltInExecutors,
  executeChatTask,
  executeAgentTask,
  executeSkillTask,
  executeScriptTask,
  executePluginTask,
  executeBackupTask,
  executeCustomTask,
} from "./executors"
export {
  cancelPluginTaskExecution,
  getActivePluginTaskCount,
  isPluginTaskExecutionActive,
} from "./executors/plugin-executor"

// Script Executor
export {
  executeScript,
  validateScript,
  getScriptTemplate,
  getSupportedLanguages,
} from "./script-executor"

// Errors
export { SchedulerError, type SchedulerErrorCode } from "./errors"

// Tab lock
export {
  isLeaderTab,
  startLeaderElection,
  stopLeaderElection,
  onLeaderChange,
  getTabId,
} from "./tab-lock"

// Format utilities
export { formatDuration, formatRelativeTime, formatNextRun } from "./format-utils"

// Event Integration
export {
  emitSchedulerEvent,
  createEventData,
  isValidEventType,
  type SchedulerEventType,
  type SchedulerEventData,
} from "./event-integration"

/** Initialize the scheduler — register executors, start the loop. */
export async function initSchedulerSystem(driver?: SchedulerTimingDriver): Promise<void> {
  registerBuiltInExecutors()
  // Before ANYTHING reads the schedule. A pre-v219 install keeps its rows in a
  // separate machine-wide database, and arming the timing driver first would
  // boot a brain with an empty schedule that silently never fires.
  try {
    const { migrateLegacySchedulerDatabase } = await import("./legacy-db-migration")
    await migrateLegacySchedulerDatabase()
  } catch (error) {
    // A failed adoption must not take the scheduler down with it: the account
    // database may still hold schedules of its own that need to run. The
    // migration leaves the legacy database in place on failure, so a later boot
    // retries.
    log.error(
      `[Scheduler] legacy schedule adoption failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  await initTaskScheduler(driver)
  const { installProviderDiagnosticsRefreshSchedule } =
    await import("@/lib/provider-diagnostics/refresh")
  await installProviderDiagnosticsRefreshSchedule()
  log.info("[Scheduler] Scheduler system initialized")
}

/** Stop the scheduler. */
export async function stopSchedulerSystem(): Promise<void> {
  stopTaskScheduler()
  log.info("[Scheduler] Scheduler system stopped")
}
