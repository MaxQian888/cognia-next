/**
 * Scheduler Notification Integration
 * Integrates with existing notification systems (desktop, toast, webhook)
 */

import type { ScheduledTask, TaskExecution, NotificationChannel } from "@/types/scheduler"
import type { NotificationChannel as CenterChannel, NotificationLevel } from "@/types/notifications"
import type { OutboundWebhookEvent, RemoteControlOutboundHeader } from "@/types/remote-control"
import { notify } from "@/lib/tauri/notification"
import { notify as centerNotify } from "@/lib/notifications/runtime"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"
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

type TaskEventType = "start" | "progress" | "complete" | "error" | "auto-paused"

function centerLevelFor(eventType: TaskEventType): NotificationLevel {
  if (eventType === "error") return "error"
  if (eventType === "auto-paused") return "warning"
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

  // Desktop ("desktop" → os) + toast + im → ONE Notification Center emit.
  const wantsToast = channels.includes("toast")
  const wantsDesktop = channels.includes("desktop")
  const wantsIm = channels.includes("im")
  const imConversationKey = wantsIm ? await resolveImConversationKey(task) : undefined
  if (wantsToast || wantsDesktop || imConversationKey) {
    const coreChannels: CenterChannel[] = ["center"]
    if (wantsToast) coreChannels.push("toast")
    if (wantsDesktop) coreChannels.push("os")
    if (imConversationKey) coreChannels.push("im")
    try {
      await centerNotify({
        source: "scheduler",
        level: centerLevelFor(eventType),
        title,
        body,
        channels: coreChannels,
        dedupeKey: `task:${task.id}:${eventType}`,
        groupKey: `task:${task.id}`,
        // `im-deliver.ts` resolves its destination from a `"conversation"`
        // sourceRef and nothing else, so an IM-bound notification has to carry
        // that instead of the task ref. Emitting two records (one per ref) would
        // double every entry in the feed, so the conversation wins and
        // `groupKey` keeps the task grouping intact either way.
        sourceRef: imConversationKey
          ? { kind: "conversation", id: imConversationKey }
          : { kind: "task", id: task.id },
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
 * Injected seam for the settings read behind the IM fallback. Tests swap it so
 * they do not need Dexie; production resolves the real `getSettings`.
 */
let injectedSettingsReader: (() => Promise<{ fallbackConversationKey?: string }>) | null = null

/** Test hook — override the scheduler-notification settings read. */
export function __setSchedulerNotificationSettingsForTesting(
  read: (() => Promise<{ fallbackConversationKey?: string }>) | null
): void {
  injectedSettingsReader = read
}

/**
 * Resolve where the `im` channel should deliver — task-level target first, then
 * the global ops channel (decision: two layers).
 *
 * Returns undefined when neither layer yields a conversation, which drops just
 * the IM channel: the durable center record is still written by the caller, so
 * the event is never lost, it simply has nowhere to be pushed.
 *
 * Deliberately does NOT verify the conversation still has a bound session —
 * `im-deliver.ts` already audits `delivery_target_missing` / `opt_in_off` with
 * the adapter context it alone has. Re-checking here would duplicate that logic
 * and lose the audit trail.
 */
async function resolveImConversationKey(task: ScheduledTask): Promise<string | undefined> {
  const taskTarget = task.notification.imTarget?.conversationKey?.trim()
  if (taskTarget) return taskTarget
  return resolveFallbackConversationKey()
}

/** Layer 2 alone — the global ops channel. Shared with the channel test. */
async function resolveFallbackConversationKey(): Promise<string | undefined> {
  try {
    if (injectedSettingsReader) {
      return (await injectedSettingsReader()).fallbackConversationKey?.trim() || undefined
    }
    // Lazy import: the settings module pulls in the Dexie graph, which the
    // scheduler's pure-node test suites must not pay for.
    const { getSettings } = await import("@/lib/db/settings")
    const settings = await getSettings()
    return settings?.schedulerNotifications?.fallbackConversationKey?.trim() || undefined
  } catch (error) {
    // A settings read failure must never break the other channels.
    log.error("Failed to resolve the scheduler IM fallback conversation:", error)
    return undefined
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

    case "auto-paused":
      return {
        title: `Task Auto-Paused: ${task.name}`,
        body: `The scheduled task "${task.name}" was paused after ${task.config.pauseAfterConsecutiveFailures ?? "several"} consecutive failures. Resume it from the scheduler once the underlying issue is fixed.`,
        icon: "⏸️",
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
    case "auto-paused":
      toast.warning(title, { description: body })
      break
    case "start":
    case "progress":
    default:
      toast.info(title, { description: body })
      break
  }
  log.debug(`Toast notification sent: ${title}`)
}

function toHeaderList(headers?: Record<string, string>): RemoteControlOutboundHeader[] {
  if (!headers) return []
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

/**
 * Send a webhook notification through the remote-control outbound egress
 * pipeline: signed (Standard Webhooks) when a secret is configured, with the
 * user's custom default headers, exponential-backoff retry, and a body
 * serialized exactly once. Also fans the same event out to any configured
 * egress endpoints.
 */
async function sendWebhookNotification(
  url: string,
  payload: Record<string, unknown>
): Promise<void> {
  const [
    { getWebhookOutboundConfig },
    { deliverWebhook },
    { publishOutboundEvent },
    { appendRemoteControlAudit },
  ] = await Promise.all([
    import("./webhook-outbound-config"),
    import("@/lib/remote-control/outbound/delivery"),
    import("@/lib/remote-control/outbound/egress-registry"),
    import("@/lib/db/remote-control-audit"),
  ])

  const cfg = await getWebhookOutboundConfig()
  const event: OutboundWebhookEvent = {
    id: "msg_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    eventType: String(payload.eventType ?? "task"),
    source: "scheduler",
    payload,
    occurredAt: new Date().toISOString(),
  }

  // Deliver to the task's own webhook URL (per-task), signed + with the user's
  // custom default headers.
  const result = await deliverWebhook({
    endpoint: {
      id: "task-webhook",
      name: "task",
      url,
      headers: toHeaderList(cfg.headers),
      enabled: true,
    },
    event,
    signingSecret: cfg.signingSecret,
    limits: cfg.delivery,
  })

  // Also fan the same event out to any standalone egress endpoints.
  void publishOutboundEvent(event)

  void appendRemoteControlAudit({
    direction: "outbound",
    kind: result.ok ? "outbound.delivered" : "outbound.failed",
    result: result.ok ? "delivered" : "failed",
    endpointId: "task-webhook",
    httpStatus: result.httpStatus,
    fields: { eventType: event.eventType, source: event.source },
  }).catch(() => {})

  if (!result.ok) {
    log.error(`Failed to send webhook notification to ${url}: ${result.error ?? result.httpStatus}`)
    throw SchedulerError.webhookFailed(
      url,
      result.httpStatus,
      result.error ? new Error(result.error) : undefined
    )
  }
  log.debug(`Webhook notification sent to: ${url}`)
}

/**
 * Test notification channels
 */
export async function testNotificationChannel(
  channel: NotificationChannel,
  webhookUrl?: string,
  imConversationKey?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    switch (channel) {
      case "im": {
        // Resolve the same two layers a real delivery uses, so the test fails
        // for exactly the reasons a real notification would.
        const conversationKey =
          imConversationKey?.trim() || (await resolveFallbackConversationKey())
        if (!conversationKey) {
          return {
            success: false,
            error:
              "No IM conversation is configured for this task, and no global ops channel is set.",
          }
        }
        const { notifyConversationOverIM } = await import("@/lib/notifications/conversation-notify")
        await notifyConversationOverIM({
          conversationKey,
          source: "scheduler",
          title: "Notification Test",
          body: "This is a test notification from the scheduler.",
          dedupeKey: `scheduler-im-test:${conversationKey}`,
        })
        // Honest wording: the push is opt-in and asynchronous (it goes through
        // the durable outbound queue), so a queued test is NOT proof of arrival.
        // `proactivePush` being off on the conversation is audited downstream as
        // `notify.im_skipped`, not reported here.
        return {
          success: true,
          error: undefined,
        }
      }
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
