/**
 * Promote App-Level Scheduled Task to System Service
 *
 * Converts an app-level ScheduledTask to a CreateSystemTaskInput
 * for registration with the OS scheduler (Windows Task Scheduler / launchd / systemd).
 *
 * Only certain task types are promotable:
 * - script → execute_script (direct mapping)
 * - workflow/backup/sync → run_command (Cognia CLI invocation)
 * - agent/chat/ai-generation/test/custom/plugin → NOT promotable (require running app)
 */

import type { ScheduledTask } from "@/types/scheduler"
import type {
  CreateSystemTaskInput,
  SystemTaskTrigger,
  SystemTaskAction,
} from "@/types/scheduler/system-scheduler"

/** Task types that can be promoted to system services */
const PROMOTABLE_TYPES = new Set(["script", "workflow", "backup", "sync"])

/** Trigger types that can be mapped to system triggers */
const PROMOTABLE_TRIGGER_TYPES = new Set(["cron", "interval", "once"])

export interface PromoteResult {
  promotable: boolean
  reason?: string
  input?: CreateSystemTaskInput
}

/**
 * Attempt to promote an app-level task to a system-level task.
 *
 * @param task - The app-level ScheduledTask to promote
 * @returns PromoteResult indicating whether promotion is possible and the mapped input
 */
export function promoteToSystemTask(task: ScheduledTask): PromoteResult {
  // Check task type
  if (!PROMOTABLE_TYPES.has(task.type)) {
    return {
      promotable: false,
      reason: `Task type "${task.type}" cannot be promoted to a system service. Only script, workflow, backup, and sync tasks are supported. Tasks of type "${task.type}" require the Cognia application to be running.`,
    }
  }

  // Check trigger type
  if (!PROMOTABLE_TRIGGER_TYPES.has(task.trigger.type)) {
    return {
      promotable: false,
      reason: `Trigger type "${task.trigger.type}" cannot be mapped to a system trigger. Only cron, interval, and once triggers are supported.`,
    }
  }

  // Map trigger
  const trigger = mapTrigger(task)
  if (!trigger) {
    return {
      promotable: false,
      reason: "Failed to map task trigger to system trigger.",
    }
  }

  // Map action
  const action = mapAction(task)
  if (!action) {
    return {
      promotable: false,
      reason: `Failed to map task type "${task.type}" to a system action.`,
    }
  }

  return {
    promotable: true,
    input: {
      name: `Cognia: ${task.name}`,
      description: task.description || `Promoted from app task: ${task.name}`,
      trigger,
      action,
      run_level: task.type === "script" ? "user" : "user",
      tags: ["cognia-promoted", ...(task.tags || [])],
    },
  }
}

function mapTrigger(task: ScheduledTask): SystemTaskTrigger | null {
  switch (task.trigger.type) {
    case "cron":
      return {
        type: "cron",
        expression: task.trigger.cronExpression || "0 9 * * *",
        timezone: task.trigger.timezone,
      }
    case "interval":
      return {
        type: "interval",
        seconds: Math.round((task.trigger.intervalMs || 3600000) / 1000),
      }
    case "once":
      return {
        type: "once",
        run_at: task.trigger.runAt
          ? task.trigger.runAt instanceof Date
            ? task.trigger.runAt.toISOString()
            : String(task.trigger.runAt)
          : new Date().toISOString(),
      }
    default:
      return null
  }
}

function mapAction(task: ScheduledTask): SystemTaskAction | null {
  const payload = task.payload || {}

  switch (task.type) {
    case "script":
      return {
        type: "execute_script",
        language: (payload.language as string) || "javascript",
        code: (payload.code as string) || "",
        working_dir: payload.workingDir as string | undefined,
        timeout_secs: payload.timeout ? Math.round(Number(payload.timeout) / 1000) : 300,
        use_sandbox: payload.useSandbox !== false,
      }

    case "workflow":
      return {
        type: "run_command",
        command: "cognia",
        args: ["run-workflow", "--id", (payload.workflowId as string) || ""],
      }

    case "backup":
      return {
        type: "run_command",
        command: "cognia",
        args: [
          "backup",
          "--type",
          (payload.backupType as string) || "full",
          "--destination",
          (payload.destination as string) || "local",
        ],
      }

    case "sync":
      return {
        type: "run_command",
        command: "cognia",
        args: ["sync", "--provider", (payload.provider as string) || "default"],
      }

    default:
      return null
  }
}
