/**
 * Scheduler module barrel — public surface used by hooks/UI/store.
 *
 * Note: cognia-next ships only the executor types it has backing systems
 * for (chat / agent / skill / script / plugin / custom). The Cognia barrel
 * additionally re-exports workflow / sync / backup helpers; those are not
 * present here.
 */

import { loggers } from "@/lib/logging"
import { initTaskScheduler, stopTaskScheduler } from "./task-scheduler"
import { registerBuiltInExecutors } from "./executors"

const log = loggers.scheduler

// Core scheduler
export {
  getTaskScheduler,
  createTaskScheduler,
  initTaskScheduler,
  stopTaskScheduler,
  registerTaskExecutor,
  unregisterTaskExecutor,
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
export async function initSchedulerSystem(): Promise<void> {
  registerBuiltInExecutors()
  await initTaskScheduler()
  log.info("[Scheduler] Scheduler system initialized")
}

/** Stop the scheduler. */
export async function stopSchedulerSystem(): Promise<void> {
  stopTaskScheduler()
  log.info("[Scheduler] Scheduler system stopped")
}
