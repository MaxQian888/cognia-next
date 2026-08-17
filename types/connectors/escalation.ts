/**
 * SLA escalation policy (ADR-0009 / IM delegation slice 1B).
 *
 * A conversation whose next-response SLA is overdue walks an ordered chain of
 * `EscalationStep`s. Each step fires exactly once per overdue window (the
 * conversation persists `escalatedStep`; `markResponded` / resolve resets it)
 * when the overdue duration reaches `afterOverdueMinutes`. Steps are ordered
 * ascending; a step carries one or more actions that run in array order.
 *
 * Where the policy lives:
 *   - `AdapterInstanceRow.defaultEscalation` — the bot-wide default.
 *   - `ConversationOverrideRow.escalation` — per-conversation override
 *     (`undefined` = inherit the adapter default).
 * The sweep (`lib/connectors/escalation/sweep.ts`) resolves
 * `override.escalation ?? adapter.defaultEscalation` and audits
 * `sla.escalated` per fired step.
 */

import type { UrgentChannel } from "./adapter"

/** Who a `reassign` step hands the conversation to (mirrors `ConversationOverrideRow.assignee`). */
export type EscalationAssignee =
  | { kind: "human" }
  | { kind: "character"; id: string; label?: string }
  | { kind: "team"; id: string; label?: string }

export type EscalationAction =
  /** Notification Center + toast (`lib/notifications/runtime.ts:notify`), dedupe `sla:<key>:<step>`. */
  | { type: "notify" }
  /** `setAssignee(..., { via: "sla-escalation" })` — routing follows the assignment (slice 1A). */
  | { type: "reassign"; assignee: EscalationAssignee }
  /** Flip the conversation mode so the AI stops auto-replying (`manual`) or drafts for approval (`draft`). */
  | { type: "switchMode"; mode: "manual" | "draft" }
  /**
   * Platform "urgent" (加急) escalation — a notice message is enqueued to the
   * conversation (or `targetConversationKey`), then `sendUrgent` is called on
   * that message id for `userIds` via `via` (defaults to the app channel).
   *
   * INTENTIONALLY INERT outside Lark: only the Lark adapter implements
   * `PlatformAdapter.sendUrgent`, so on every other platform this action is
   * recorded as `sla.escalation_action_failed` (reason `unsupported_platform`)
   * and the chain continues. The editor renders the action disabled with the
   * `urgentLarkOnly` hint on non-Lark adapters, and
   * `escalation-policy-editor.test.tsx` pins the disabled state.
   */
  | {
      type: "urgent"
      userIds: string[]
      via?: UrgentChannel
      /** Send the notice + urgent to another conversation (e.g. an ops group) instead of the overdue one. */
      targetConversationKey?: string
    }

export type EscalationActionType = EscalationAction["type"]

export interface EscalationStep {
  /** Minutes past `nextResponseDueAt` at which this step fires (>= 0, ascending across steps). */
  afterOverdueMinutes: number
  /** At least one action; executed in order. */
  actions: EscalationAction[]
}

export interface EscalationPolicy {
  steps: EscalationStep[]
}

/** Upper bound on the chain length accepted by `validateEscalationPolicy`. */
export const MAX_ESCALATION_STEPS = 10

export const ESCALATION_ACTION_TYPES: readonly EscalationActionType[] = [
  "notify",
  "reassign",
  "switchMode",
  "urgent",
]

/** Platforms whose adapters implement `sendUrgent`; the `urgent` action is inert elsewhere. */
export const URGENT_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(["lark"])

export function isUrgentCapablePlatform(platform: string | undefined): boolean {
  return platform !== undefined && URGENT_CAPABLE_PLATFORMS.has(platform)
}
