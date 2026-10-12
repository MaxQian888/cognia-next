/**
 * Every text this Bot writes to GitHub that is not a model answer comes from
 * a fixed template in the plugin's own message bundle. A template carries
 * only safe values (an opaque task reference, a status, a number, a URL
 * GitHub returned), never the command text, code, logs or anything private.
 */

import type { PluginContext } from "@cognia/plugin-sdk"

import { MAX_COMMAND_BYTES, type CommandVerb } from "./command-source"

export type UsageReason =
  | "multiple_commands"
  | "reserved_verb"
  | "unknown_verb"
  | "too_large"
  | "bad_task_ref"
  | "review_on_issue"

export type TaskState = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"

/** Why an answer was not published, as a stable public code. */
export type BlockedReason =
  | "pii_blocked"
  | "readonly_violation"
  | "budget_exceeded"
  | "recovery_required"
  | "invalid_result"
  | "target_changed"
  | "context_unavailable"

export type ReplyRequest =
  | { kind: "help" }
  | { kind: "status"; taskRef?: string }
  | { kind: "cancelled"; taskRefs: string[] }
  | { kind: "usage"; reason: UsageReason; verb?: string }
  | { kind: "not_enabled"; verb: Extract<CommandVerb, "fix" | "retry"> }
  | { kind: "expired" }

type T = PluginContext["i18n"]["t"]

export function helpText(t: T, trigger: string): string {
  return t("reply.help", { trigger })
}

export function usageText(t: T, reason: UsageReason, trigger: string, verb?: string): string {
  return [
    t(`reply.usage.${reason}`, {
      verb: verb ?? "",
      maxKiB: Math.floor(MAX_COMMAND_BYTES / 1024),
    }),
    helpText(t, trigger),
  ].join("\n\n")
}

export function notEnabledText(t: T, verb: string): string {
  return t("reply.notEnabled", { verb })
}

export function expiredText(t: T, hours: number): string {
  return t("reply.expired", { hours })
}

export function cancelledText(t: T, refs: string[]): string {
  return refs.length
    ? t("reply.cancelled", { refs: refs.map((ref) => `\`${ref}\``).join(", ") })
    : t("reply.cancelNothing")
}

export interface StatusLine {
  ref: string
  state: TaskState
  url?: string
}

export function statusText(t: T, lines: StatusLine[]): string {
  if (!lines.length) return t("reply.status.none")
  return [
    t("reply.status.header"),
    ...lines.map(
      (line) =>
        `- \`${line.ref}\`: ${t(`task.state.${line.state}`)}${line.url ? ` (${line.url})` : ""}`
    ),
  ].join("\n")
}

export function trackingText(
  t: T,
  ref: string,
  phase:
    | { kind: "running" }
    | { kind: "completed"; url?: string }
    | { kind: "blocked"; reason: BlockedReason }
    | { kind: "failed" }
    | { kind: "cancelled" }
    | { kind: "waiting" }
): string {
  switch (phase.kind) {
    case "running":
      return t("tracking.running", { ref })
    case "waiting":
      return t("tracking.waiting", { ref })
    case "completed":
      return phase.url
        ? t("tracking.completedAt", { ref, url: phase.url })
        : t("tracking.completed", { ref })
    case "blocked":
      return t(`tracking.blocked.${phase.reason}`, { ref })
    case "failed":
      return t("tracking.failed", { ref })
    case "cancelled":
      return t("tracking.cancelled", { ref })
  }
}
