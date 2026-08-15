/**
 * Promote an app-level scheduled task to the OS scheduler
 * (Windows Task Scheduler / launchd / systemd) — "wake + delegate" semantics
 * (spec `docs/superpowers/specs/2026-08-16-scheduler-host-neutral-design.md`, C).
 *
 * The OS timer never runs the task's payload itself. It fires an `open_url`
 * action for the app's deep link
 *
 *   cognia://scheduler/task/<taskId>?run=<token>
 *
 * which launches (or focuses) the Cognia desktop app; the deep-link handler
 * verifies `token` against the task's stored promotion record and runs the
 * task through the normal scheduler execution path. That makes EVERY task
 * type promotable with one uniform behaviour, instead of the previous
 * per-type mapping onto CLI subcommands that did not exist.
 *
 * Still not promotable:
 *   - `event` triggers (no OS equivalent) — and deprecated task types;
 *   - cron grammar the OS backend cannot express (seconds field, macros,
 *     `L`/`#`, and on launchd steps/ranges/lists) — rejected with a reason,
 *     never approximated (ADR-0079 §6).
 *
 * The token is a per-promotion secret so an arbitrary web page linking to
 * `cognia://scheduler/task/<id>` can only navigate, never execute.
 */

import type { ScheduledTask } from "@/types/scheduler"
import type {
  CreateSystemTaskInput,
  SystemTaskTrigger,
  SystemTaskAction,
} from "@/types/scheduler/system-scheduler"
import { validateCronExpression } from "./cron-parser"
import { isDeprecatedTaskType } from "./host-support"

/** Trigger types that can be mapped to system triggers */
export const PROMOTABLE_TRIGGER_TYPES: ReadonlySet<string> = new Set(["cron", "interval", "once"])

/** Tag every promoted OS task carries so the unified list can link it back. */
export const PROMOTED_TASK_TAG = "cognia-promoted"

export interface PromoteResult {
  promotable: boolean
  reason?: string
  input?: CreateSystemTaskInput
  /** The wake-up token embedded in `input.action.url` (store it on the task). */
  token?: string
}

/** Deep link the OS timer opens; the desktop handler runs the task iff `token` matches. */
export function buildPromotionWakeUrl(taskId: string, token: string): string {
  return `cognia://scheduler/task/${encodeURIComponent(taskId)}?run=${encodeURIComponent(token)}`
}

/** 32 random bytes as base64url — URL-safe, no padding. */
export function generatePromotionToken(rng: (bytes: Uint8Array) => void = fillRandom): string {
  const bytes = new Uint8Array(32)
  rng(bytes)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64")
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function fillRandom(bytes: Uint8Array): void {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes)
    return
  }
  throw new Error("secure random source unavailable; cannot mint a promotion token")
}

/**
 * Constant-time-ish comparison of the deep-link token against the stored one
 * (lengths compared first, then every byte XORed) so timing does not leak.
 */
export function promotionTokenMatches(
  stored: string | undefined,
  presented: string | undefined
): boolean {
  if (!stored || !presented || stored.length !== presented.length) return false
  let diff = 0
  for (let i = 0; i < stored.length; i += 1) diff |= stored.charCodeAt(i) ^ presented.charCodeAt(i)
  return diff === 0
}

export type SystemSchedulerPlatform = "macos" | "windows" | "linux" | "unknown"

/**
 * Attempt to promote an app-level task to a system-level task.
 *
 * @param task - The app-level ScheduledTask to promote
 * @returns PromoteResult indicating whether promotion is possible and the mapped input
 */
export function promoteToSystemTask(
  task: ScheduledTask,
  platform: SystemSchedulerPlatform = detectSystemSchedulerPlatform(),
  options: { token?: string } = {}
): PromoteResult {
  // Deprecated types have no executor — waking the app for them is pointless.
  if (isDeprecatedTaskType(task.type)) {
    return {
      promotable: false,
      reason: `Task type "${task.type}" is deprecated and cannot be promoted.`,
    }
  }

  // Check trigger type
  if (!PROMOTABLE_TRIGGER_TYPES.has(task.trigger.type)) {
    return {
      promotable: false,
      reason: `Trigger type "${task.trigger.type}" cannot be mapped to a system trigger. Only cron, interval, and once triggers are supported.`,
    }
  }

  // Guard cron grammar: OS schedulers (schtasks / launchd / systemd) express
  // only classic 5-field cron. The app now supports richer OCPS grammar
  // (seconds, macros, `L` last-day, `#` nth-weekday) that cannot be promoted
  // without silently losing semantics — reject explicitly with a clear reason
  // rather than letting the Rust backend fail with an opaque "exactly 5 fields"
  // message.
  if (task.trigger.type === "cron" && task.trigger.cronExpression) {
    const guard = checkOsCronCompatibility(task.trigger.cronExpression, platform)
    if (!guard.ok) {
      return { promotable: false, reason: guard.reason }
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

  // Action: wake the app through its deep link; the app runs the task.
  const token = options.token ?? generatePromotionToken()
  const action: SystemTaskAction = { type: "open_url", url: buildPromotionWakeUrl(task.id, token) }

  return {
    promotable: true,
    token,
    input: {
      name: `Cognia: ${task.name}`,
      description: task.description || `Promoted from app task: ${task.name}`,
      trigger,
      action,
      run_level: "user",
      tags: [PROMOTED_TASK_TAG, `cognia-task:${task.id}`, ...(task.tags || [])],
    },
  }
}

/**
 * Verify a cron expression can be expressed by the OS scheduler backends, which
 * only support classic 5-field cron. Returns a specific reason on rejection.
 */
function checkOsCronCompatibility(
  expression: string,
  platform: SystemSchedulerPlatform
): { ok: true } | { ok: false; reason: string } {
  const validation = validateCronExpression(expression)
  if (!validation.valid) {
    return {
      ok: false,
      reason: `Invalid cron expression: ${validation.error ?? "unparseable"}.`,
    }
  }

  const trimmed = expression.trim()
  if (trimmed.startsWith("@")) {
    return {
      ok: false,
      reason: `Cron macros (e.g. "${trimmed}") cannot be promoted to a system service. Use an explicit 5-field expression.`,
    }
  }
  if (trimmed.split(/\s+/).length > 5) {
    return {
      ok: false,
      reason:
        "Seconds-level (6-field) cron expressions are not supported by the OS scheduler. Use a 5-field expression (minute hour day month weekday).",
    }
  }
  if (/[L#]/i.test(trimmed)) {
    return {
      ok: false,
      reason:
        "Advanced cron modifiers (L for last-day, # for nth-weekday) are not supported by the OS scheduler. Use a plain 5-field expression.",
    }
  }
  if (platform !== "macos") return { ok: true }

  const fields = trimmed.split(/\s+/)
  const stepped = fields.find((field) => field.includes("/"))
  if (stepped) {
    return {
      ok: false,
      reason:
        'Step cron field "' +
        stepped +
        '" cannot be promoted because launchd requires a wildcard or one fixed value.',
    }
  }
  const ranged = fields.find((field) => field.includes("-"))
  if (ranged) {
    return {
      ok: false,
      reason:
        'Range cron field "' +
        ranged +
        '" cannot be promoted because launchd requires a wildcard or one fixed value.',
    }
  }
  const listed = fields.find((field) => field.includes(","))
  if (listed) {
    return {
      ok: false,
      reason:
        'List cron field "' +
        listed +
        '" cannot be promoted because launchd requires a wildcard or one fixed value.',
    }
  }
  return { ok: true }
}

function detectSystemSchedulerPlatform(): SystemSchedulerPlatform {
  if (typeof navigator !== "undefined") {
    const userAgent = navigator.userAgent.toLowerCase()
    if (userAgent.includes("mac")) return "macos"
    if (userAgent.includes("win")) return "windows"
    if (userAgent.includes("linux")) return "linux"
  }
  if (typeof process !== "undefined") {
    if (process.platform === "darwin") return "macos"
    if (process.platform === "win32") return "windows"
    if (process.platform === "linux") return "linux"
  }
  return "unknown"
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
