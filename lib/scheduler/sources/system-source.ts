/**
 * System-source adapter: surfaces every OS-level scheduled task (Windows
 * Task Scheduler / launchd / cron) from `@/lib/native/system-scheduler`.
 *
 * The Tauri sidecar already owns CRUD here; this adapter normalizes the
 * shape and forwards calls. Confirmation flows (admin elevation, dangerous
 * action prompts) intentionally do NOT flow through this adapter — the form
 * UI uses `useSystemScheduler` directly so it can render the confirmation
 * dialog inline.
 *
 * Subscribe semantics: the OS scheduler doesn't push change events, so the
 * adapter polls every 30s by default. Tests inject a pollInterval of 0 and
 * call the helpers synchronously.
 */

import { isTauri } from "@/lib/tauri"
import * as native from "@/lib/native/system-scheduler"
import type {
  CreateSystemTaskInput,
  SystemTask,
  SystemTaskId,
  SystemTaskStatus,
  SystemTaskTrigger,
} from "@/types/scheduler"
import {
  makeUnifiedId,
  type UnifiedScheduledItem,
  type UnifiedItemStatus,
} from "@/types/scheduler/unified"
import type {
  ScheduledItemSource,
  ScheduledItemSourceObserver,
  ScheduledItemSubscription,
} from "./types"

const POLL_INTERVAL_MS = 30_000

interface SystemSourceNative {
  listSystemTasks(): Promise<SystemTask[]>
  getSystemTask(id: SystemTaskId): Promise<SystemTask | null>
  createSystemTask(input: CreateSystemTaskInput): Promise<unknown>
  updateSystemTask(id: SystemTaskId, input: CreateSystemTaskInput): Promise<unknown>
  deleteSystemTask(id: SystemTaskId): Promise<boolean>
  enableSystemTask(id: SystemTaskId): Promise<boolean>
  disableSystemTask(id: SystemTaskId): Promise<boolean>
  runSystemTaskNow(id: SystemTaskId): Promise<unknown>
}

export interface SystemSourceDeps {
  native?: SystemSourceNative
  pollIntervalMs?: number
  /** Override the Tauri-detection so web tests can opt in. */
  isAvailable?: () => boolean
}

export function createSystemSource(
  deps: SystemSourceDeps = {}
): ScheduledItemSource<CreateSystemTaskInput, CreateSystemTaskInput> {
  const nativeAdapter = deps.native ?? (native as unknown as SystemSourceNative)
  const pollMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS
  const available = deps.isAvailable ?? isTauri

  return {
    kind: "system",

    subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription {
      let cancelled = false
      const emit = async () => {
        if (!available()) {
          observer.next([])
          return
        }
        try {
          const tasks = await nativeAdapter.listSystemTasks()
          if (cancelled) return
          observer.next(tasks.map(toUnifiedSystemTask))
        } catch (err) {
          observer.error?.(err)
        }
      }
      void emit()
      const timer =
        pollMs > 0 && typeof setInterval === "function"
          ? setInterval(() => void emit(), pollMs)
          : null
      return {
        unsubscribe() {
          cancelled = true
          if (timer) clearInterval(timer)
        },
      }
    },

    async list(): Promise<UnifiedScheduledItem[]> {
      if (!available()) return []
      const tasks = await nativeAdapter.listSystemTasks()
      return tasks.map(toUnifiedSystemTask)
    },

    async get(sourceId: string): Promise<UnifiedScheduledItem | undefined> {
      if (!available()) return undefined
      const task = await nativeAdapter.getSystemTask(sourceId)
      return task ? toUnifiedSystemTask(task) : undefined
    },

    async create(input: CreateSystemTaskInput): Promise<UnifiedScheduledItem> {
      const result = (await nativeAdapter.createSystemTask(input)) as
        { task?: SystemTask } | unknown
      const task =
        result && typeof result === "object" && "task" in result && result.task
          ? (result as { task: SystemTask }).task
          : await nativeAdapter
              .listSystemTasks()
              .then((tasks) => tasks.find((t) => t.name === input.name))
      if (!task) {
        throw new Error("System task created but could not be located after creation.")
      }
      return toUnifiedSystemTask(task)
    },

    async update(sourceId: string, input: CreateSystemTaskInput): Promise<void> {
      await nativeAdapter.updateSystemTask(sourceId, input)
    },

    async delete(sourceId: string): Promise<void> {
      await nativeAdapter.deleteSystemTask(sourceId)
    },

    async pause(sourceId: string): Promise<void> {
      await nativeAdapter.disableSystemTask(sourceId)
    },

    async resume(sourceId: string): Promise<void> {
      await nativeAdapter.enableSystemTask(sourceId)
    },

    async runNow(sourceId: string): Promise<void> {
      await nativeAdapter.runSystemTaskNow(sourceId)
    },
  }
}

export function toUnifiedSystemTask(task: SystemTask): UnifiedScheduledItem {
  return {
    unifiedId: makeUnifiedId("system", task.id),
    kind: "system",
    sourceId: task.id,
    name: task.name,
    description: task.description,
    status: mapSystemStatus(task.status),
    triggerSummary: summarizeSystemTrigger(task.trigger),
    nextRunAt: task.next_run_at ? Date.parse(task.next_run_at) : undefined,
    lastRunAt: task.last_run_at ? Date.parse(task.last_run_at) : undefined,
    origin: {
      deepLinkHref: `/scheduler?systemTaskId=${encodeURIComponent(task.id)}`,
    },
    capabilities: {
      runNow: true,
      pause: true,
      edit: true,
      delete: true,
    },
  }
}

function mapSystemStatus(status: SystemTaskStatus): UnifiedItemStatus {
  switch (status) {
    case "enabled":
    case "running":
    case "completed":
      return "active"
    case "disabled":
      return "paused"
    case "failed":
      return "disabled"
    default:
      return "unknown"
  }
}

function summarizeSystemTrigger(
  trigger: SystemTaskTrigger
): UnifiedScheduledItem["triggerSummary"] {
  switch (trigger.type) {
    case "cron":
      return { type: "cron", cron: trigger.expression, timezone: trigger.timezone }
    case "interval":
      return { type: "interval", intervalMs: trigger.seconds * 1000 }
    case "once":
      return { type: "once", runAtMs: Date.parse(trigger.run_at) }
    default:
      return { type: "event", eventType: trigger.type }
  }
}
