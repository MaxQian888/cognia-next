/**
 * Scheduler Notification Integration
 * Integrates with existing notification systems (desktop, toast, webhook)
 */

import type { ScheduledTask, TaskExecution, NotificationChannel } from "@/types/scheduler"
import type { NotificationChannel as CenterChannel, NotificationLevel } from "@/types/notifications"
import { notify } from "@/lib/tauri/notification"
import { notify as centerNotify } from "@/lib/notifications/runtime"
import { toast } from "sonner"
import { loggers } from "@/lib/logging"
import { SchedulerError } from "./errors"
import { formatDuration } from "./format-utils"

// Logger
const log = loggers.scheduler

/**
 * Default retry / timeout limits applied to outbound webhook deliveries.
 * Surfaced read-only in the Remote Control settings UI.
 */
export const WEBHOOK_DELIVERY_LIMITS = {
  retries: 3,
  baseDelayMs: 1000,
  timeoutMs: 10_000,
} as const

type TaskEventType = "start" | "progress" | "complete" | "error"

function centerLevelFor(eventType: TaskEventType): NotificationLevel {
  if (eventType === "error") return "error"
  if (eventType === "complete") return "success"
  return "info"
}

/**
 * Notify about a task event.
 *
 * Desktop + toast channels funnel through the Unified Notification Center
 * (ADR-0042): one durable record + preference-governed fan-out. The webhook
 * channel stays a scheduler-owned outbound HTTP integration (not a user-facing
 * notification), so it is dispatched directly here.
 */
export async function notifyTaskEvent(
  task: ScheduledTask,
  execution: TaskExecution,
  eventType: TaskEventType
): Promise<void> {
  const channels = task.notification.channels ?? []

  if (channels.includes("none") || channels.length === 0) {
    return
  }

  const { title, body } = getNotificationContent(task, execution, eventType)

  // Desktop ("desktop" → os) + toast → one Notification Center emit.
  const wantsToast = channels.includes("toast")
  const wantsDesktop = channels.includes("desktop")
  if (wantsToast || wantsDesktop) {
    const coreChannels: CenterChannel[] = ["center"]
    if (wantsToast) coreChannels.push("toast")
    if (wantsDesktop) coreChannels.push("os")
    try {
      await centerNotify({
        source: "scheduler",
        level: centerLevelFor(eventType),
        title,
        body,
        channels: coreChannels,
        dedupeKey: `task:${task.id}:${eventType}`,
        groupKey: `task:${task.id}`,
        sourceRef: { kind: "task", id: task.id },
      })
    } catch (error) {
      log.error("Failed to dispatch scheduler notification to the center:", error)
    }
  }

  // Webhook — scheduler-owned outbound integration, retained verbatim.
  if (channels.includes("webhook") && task.notification.webhookUrl) {
    try {
      await sendWebhookNotification(task.notification.webhookUrl, {
        task: { id: task.id, name: task.name, type: task.type },
        execution: {
          id: execution.id,
          status: execution.status,
          duration: execution.duration,
          error: execution.error,
        },
        eventType,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      log.error("Failed to send webhook notification:", error)
    }
  }
}

/**
 * Get notification content based on event type
 */
function getNotificationContent(
  task: ScheduledTask,
  execution: TaskExecution,
  eventType: TaskEventType
): { title: string; body: string; icon: string } {
  switch (eventType) {
    case "start":
      return {
        title: `Task Started: ${task.name}`,
        body: `The scheduled task "${task.name}" has started execution.`,
        icon: "🚀",
      }

    case "progress":
      return {
        title: `Task Progress: ${task.name}`,
        body: `Task "${task.name}" is in progress...`,
        icon: "⏳",
      }

    case "complete":
      const duration = execution.duration
        ? `Completed in ${formatDuration(execution.duration)}.`
        : "Completed successfully."
      return {
        title: `Task Completed: ${task.name}`,
        body: `The scheduled task "${task.name}" has completed. ${duration}`,
        icon: "✅",
      }

    case "error":
      return {
        title: `Task Failed: ${task.name}`,
        body: `The scheduled task "${task.name}" failed: ${execution.error || "Unknown error"}`,
        icon: "❌",
      }

    default:
      return {
        title: `Task Event: ${task.name}`,
        body: `Event occurred for task "${task.name}".`,
        icon: "ℹ️",
      }
  }
}

/**
 * Send desktop notification
 */
async function sendDesktopNotification(title: string, body: string): Promise<void> {
  try {
    await notify({ title, body })
    log.debug(`Desktop notification sent: ${title}`)
  } catch (error) {
    log.warn("Failed to send desktop notification:", { error })
  }
}

/**
 * Send toast notification — sonner uses (message, options) shape, with the
 * descriptive body passed as `description` rather than as a positional arg.
 */
function sendToastNotification(title: string, body: string, eventType: TaskEventType): void {
  switch (eventType) {
    case "complete":
      toast.success(title, { description: body })
      break
    case "error":
      toast.error(title, { description: body })
      break
    case "start":
    case "progress":
    default:
      toast.info(title, { description: body })
      break
  }
  log.debug(`Toast notification sent: ${title}`)
}

/**
 * Send webhook notification with retry and timeout
 */
async function sendWebhookNotification(
  url: string,
  payload: Record<string, unknown>
): Promise<void> {
  const MAX_RETRIES = 3
  const BASE_DELAY = 1000 // 1s
  const TIMEOUT_MS = 10000 // 10s

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!response.ok) {
        throw SchedulerError.webhookFailed(url, response.status)
      }

      log.debug(`Webhook notification sent to: ${url}`)
      return
    } catch (error) {
      clearTimeout(timer)

      if (attempt === MAX_RETRIES) {
        log.error(
          `Failed to send webhook notification to ${url} after ${MAX_RETRIES + 1} attempts:`,
          error
        )
        throw SchedulerError.webhookFailed(
          url,
          undefined,
          error instanceof Error ? error : undefined
        )
      }

      const delay = BASE_DELAY * Math.pow(2, attempt) + Math.random() * 500
      log.warn(
        `Webhook attempt ${attempt + 1} failed for ${url}, retrying in ${Math.round(delay)}ms`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Test notification channels
 */
export async function testNotificationChannel(
  channel: NotificationChannel,
  webhookUrl?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    switch (channel) {
      case "desktop":
        await sendDesktopNotification(
          "Notification Test",
          "This is a test notification from the scheduler."
        )
        break

      case "toast":
        sendToastNotification(
          "Notification Test",
          "This is a test notification from the scheduler.",
          "start"
        )
        break

      case "webhook":
        if (!webhookUrl) {
          return { success: false, error: "Webhook URL is required" }
        }
        await sendWebhookNotification(webhookUrl, {
          test: true,
          message: "This is a test notification from the scheduler.",
          timestamp: new Date().toISOString(),
        })
        break

      case "none":
        return { success: true }
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
}
