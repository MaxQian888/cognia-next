import type {
  BackgroundCommandTaskPayload,
  MonitorTaskPayload,
  ScheduledTask,
  TaskExecution,
  TaskExecutorResult,
} from "@/types/scheduler"
import {
  registerScheduledBackgroundMonitor,
  spawnScheduledBackgroundJob,
} from "@/lib/jobs/background-jobs"
import { assertTaskTypeSupportedOnHost } from "../host-support"

type ExecutionResult = TaskExecutorResult

export async function executeBackgroundCommandTask(
  task: ScheduledTask,
  _execution: TaskExecution,
  signal: AbortSignal
): Promise<ExecutionResult> {
  // Host gate: the jobs supervisor spawns a real process. `shell` is the
  // capability that says the host can; a browser/mobile webview cannot, and
  // must say so structurally instead of throwing from the RPC layer.
  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) return refused

  const payload = task.payload as Partial<BackgroundCommandTaskPayload> | undefined
  if (!payload?.command?.trim()) {
    return { success: false, error: "background-command task requires `command` in payload" }
  }
  if (!payload.cwd?.trim()) {
    return { success: false, error: "background-command task requires absolute `cwd` in payload" }
  }
  if (signal.aborted) {
    return { success: false, error: "Background command task aborted before start" }
  }

  try {
    const job = await spawnScheduledBackgroundJob({
      taskId: task.id,
      command: payload.command,
      cwd: payload.cwd,
      label: payload.label ?? task.name,
    })
    return {
      success: true,
      output: { jobId: job.id, status: job.status, owner: job.owner },
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function expiryMillis(value: MonitorTaskPayload["expiresAt"]): number | undefined {
  if (value === undefined) return undefined
  const millis = typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(millis) ? millis : undefined
}

export async function executeMonitorTask(
  task: ScheduledTask,
  _execution: TaskExecution,
  signal: AbortSignal
): Promise<ExecutionResult> {
  // Host gate: a monitor registers against the same process supervisor.
  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) return refused

  const payload = task.payload as Partial<MonitorTaskPayload> | undefined
  if (!payload?.condition) {
    return { success: false, error: "monitor task requires `condition` in payload" }
  }
  if (payload.expiresAt !== undefined && expiryMillis(payload.expiresAt) === undefined) {
    return { success: false, error: "monitor task `expiresAt` must be an ISO date or epoch millis" }
  }
  if (signal.aborted) {
    return { success: false, error: "Monitor task aborted before registration" }
  }

  try {
    const monitor = await registerScheduledBackgroundMonitor({
      taskId: task.id,
      condition: payload.condition,
      expiresAtMs: expiryMillis(payload.expiresAt),
      label: payload.label ?? task.name,
    })
    return {
      success: true,
      output: { monitorId: monitor.id, status: monitor.status, owner: monitor.owner },
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
