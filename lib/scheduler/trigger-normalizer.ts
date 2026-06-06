/**
 * Scheduler trigger normalization and validation.
 * This module is used by scheduler-core entry points (create/update/import)
 * so validation behavior is consistent across UI and programmatic flows.
 */

import type { TaskTrigger } from "@/types/scheduler"
import { validateCronExpression } from "./cron-parser"
import { SchedulerError } from "./errors"

interface NormalizeTaskTriggerOptions {
  now?: Date
}

/** Clamp jitter to a non-negative integer; invalid / zero values drop to undefined. */
function normalizeJitterMs(jitterMs?: number): number | undefined {
  const value = Number(jitterMs)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function normalizeDependsOn(dependsOn?: string[]): string[] | undefined {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) {
    return undefined
  }

  const unique = Array.from(
    new Set(dependsOn.map((taskId) => String(taskId).trim()).filter((taskId) => taskId.length > 0))
  )
  return unique.length > 0 ? unique : undefined
}

export function isValidTimezone(timezone: string): boolean {
  try {
    // Throws RangeError for unknown IANA timezone names.
    Intl.DateTimeFormat("en-US", { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export function normalizeTaskTrigger(
  trigger: TaskTrigger,
  options: NormalizeTaskTriggerOptions = {}
): TaskTrigger {
  if (!trigger || typeof trigger !== "object" || !trigger.type) {
    throw SchedulerError.invalidTrigger("Trigger payload is required")
  }

  const now = options.now ?? new Date()
  const dependsOn = normalizeDependsOn(trigger.dependsOn)

  switch (trigger.type) {
    case "cron": {
      const cronExpression = String(trigger.cronExpression || "").trim()
      if (!cronExpression) {
        throw SchedulerError.invalidTrigger("Cron trigger requires cronExpression", {
          triggerType: "cron",
          field: "cronExpression",
        })
      }

      const validation = validateCronExpression(cronExpression)
      if (!validation.valid) {
        throw SchedulerError.invalidCron(cronExpression, validation.error)
      }

      const timezone = trigger.timezone ? String(trigger.timezone).trim() : undefined
      if (timezone && !isValidTimezone(timezone)) {
        throw SchedulerError.invalidTimezone(timezone)
      }

      return {
        type: "cron",
        cronExpression,
        timezone,
        dependsOn,
        jitterMs: normalizeJitterMs(trigger.jitterMs),
      }
    }

    case "interval": {
      const intervalMs = Number(trigger.intervalMs)
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw SchedulerError.invalidTrigger("Interval trigger requires intervalMs > 0", {
          triggerType: "interval",
          field: "intervalMs",
          value: trigger.intervalMs,
        })
      }

      return {
        type: "interval",
        intervalMs: Math.floor(intervalMs),
        dependsOn,
        jitterMs: normalizeJitterMs(trigger.jitterMs),
      }
    }

    case "once": {
      const rawRunAt = trigger.runAt
      const runAt = rawRunAt instanceof Date ? rawRunAt : rawRunAt ? new Date(rawRunAt) : undefined

      if (!runAt || Number.isNaN(runAt.getTime())) {
        throw SchedulerError.invalidTrigger("One-time trigger requires a valid runAt", {
          triggerType: "once",
          field: "runAt",
          value: rawRunAt,
        })
      }

      if (runAt <= now) {
        throw SchedulerError.invalidTrigger("One-time trigger runAt must be in the future", {
          triggerType: "once",
          field: "runAt",
          value: runAt.toISOString(),
        })
      }

      return {
        type: "once",
        runAt,
        timezone: trigger.timezone ? String(trigger.timezone).trim() : undefined,
        dependsOn,
      }
    }

    case "event": {
      const eventType = String(trigger.eventType || "").trim()
      if (!eventType) {
        throw SchedulerError.invalidTrigger("Event trigger requires eventType", {
          triggerType: "event",
          field: "eventType",
        })
      }

      return {
        type: "event",
        eventType,
        eventSource: trigger.eventSource ? String(trigger.eventSource).trim() : undefined,
        dependsOn,
      }
    }

    default:
      throw SchedulerError.invalidTrigger(
        `Unsupported trigger type: ${(trigger as TaskTrigger).type}`,
        {
          triggerType: (trigger as TaskTrigger).type,
        }
      )
  }
}
