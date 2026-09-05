/**
 * Catalogue coverage for the cockpit's DYNAMIC translation keys.
 *
 * `lint:i18n` verifies literal `t("a.b")` references and skips interpolated
 * ones — this repo currently has 1544 of those, and every key the cockpit
 * builds from a status, kind, category or refusal reason is one of them. A
 * missing entry therefore passes every gate and renders a raw internal
 * identifier to the user.
 *
 * Each list below is typed as its union, and the `never` assertion beside it
 * fails the TYPECHECK if a union grows without the list growing with it. The
 * runtime assertion then proves the key exists in both locales. Together they
 * catch both halves: a new enum member, and a new member with no translation.
 */

import en from "@/i18n/messages/en/agentRuns.json"
import zh from "@/i18n/messages/zh-CN/agentRuns.json"
import enExecution from "@/i18n/messages/en/execution.json"
import zhExecution from "@/i18n/messages/zh-CN/execution.json"

import { RUN_KIND_LABEL_KEYS } from "@/lib/execution/cockpit-model"
import { CHANGE_KIND_LABEL_KEYS } from "@/lib/execution/run-detail-model"
import { EXECUTION_FILTER_KINDS } from "@/lib/execution/monitor-model"
import type { CockpitStatusGroup } from "@/lib/execution/cockpit-model"
import type { UnifiedExecutionStatus } from "@/lib/execution/monitor-model"
import type { RunControlOutcomeReason } from "@/hooks/agent-runs/use-agent-run-actions"
import type { SteerDegradedReason } from "@/lib/execution/run-control"
import type {
  ExecutionRunInterruptStatus,
  RunActivityCategory,
  RunActivityStatus,
  RunControlAction,
  RunVerificationConclusion,
  SquadReviewKind,
  TeamRecoveryChoice,
} from "@/types/execution/run"

/** Fails to compile when `Values` has a member `List` does not cover. */
type Covers<Union, List extends readonly Union[]> =
  Exclude<Union, List[number]> extends never ? true : never

const STATUS_GROUPS = ["running", "waiting", "failed", "finished"] as const
const _statusGroups: Covers<CockpitStatusGroup, typeof STATUS_GROUPS> = true

const STATUSES = ["queued", "running", "waiting", "done", "error", "cancelled"] as const
const _statuses: Covers<UnifiedExecutionStatus, typeof STATUSES> = true

const ACTIVITY_CATEGORIES = [
  "search",
  "read",
  "write",
  "command",
  "integration",
  "skill",
  "artifact",
  "approval",
  "status",
] as const
const _categories: Covers<RunActivityCategory, typeof ACTIVITY_CATEGORIES> = true

const ACTIVITY_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "blocked",
] as const
const _activityStatuses: Covers<RunActivityStatus, typeof ACTIVITY_STATUSES> = true

const INTERRUPT_STATUSES = ["pending", "approved", "denied", "expired"] as const
const _interruptStatuses: Covers<ExecutionRunInterruptStatus, typeof INTERRUPT_STATUSES> = true

const CONCLUSIONS = ["passed", "failed", "inconclusive"] as const
const _conclusions: Covers<RunVerificationConclusion, typeof CONCLUSIONS> = true

const DEGRADED_REASONS = [
  "provider_unsupported",
  "not_admitted",
  "pii_blocked",
  "store_failed",
  "no_active_run",
] as const
const _degraded: Covers<SteerDegradedReason, typeof DEGRADED_REASONS> = true

const OUTCOME_REASONS = [
  "run_not_found",
  "forbidden",
  "revision_conflict",
  "unsupported",
  "interrupt_not_found",
  "interrupt_expired",
  "interrupt_resolved",
  "source_rejected",
  "unsupported_for_kind",
  "steer_degraded",
  "invalid_command",
  "already_retried",
  "not_controllable",
  "action_unavailable",
] as const
const _outcomes: Covers<RunControlOutcomeReason, typeof OUTCOME_REASONS> = true

/** The verbs the pane can render. `open_details` is navigation, not a button. */
const CONTROL_ACTIONS = ["stop", "pause", "resume", "approve", "deny", "retry", "steer"] as const
const _controls: Covers<Exclude<RunControlAction, "open_details">, typeof CONTROL_ACTIONS> = true

/** Every Squad review kind has a form title, description and two verbs (ADR-0169). */
const REVIEW_KINDS = [
  "plan",
  "capability_audit",
  "budget_extension",
  "deadlock",
  "teammate_repair",
  "replan",
  "team_recovery",
] as const
const _reviewKinds: Covers<SquadReviewKind, typeof REVIEW_KINDS> = true

const RECOVERY_CHOICES = ["retry_same_host", "retry_host", "restart_run", "terminate"] as const
const _recoveryChoices: Covers<TeamRecoveryChoice, typeof RECOVERY_CHOICES> = true

/** The reason codes `run-reducer.ts` writes into `waitingReason`. */
const WAITING_REASONS = ["waiting_review", "recovery_required"] as const

// Reference the compile-time witnesses so lint does not strip them.
void [
  _reviewKinds,
  _recoveryChoices,
  _statusGroups,
  _statuses,
  _categories,
  _activityStatuses,
  _interruptStatuses,
  _conclusions,
  _degraded,
  _outcomes,
  _controls,
]

function expectKeys(
  section: Record<string, unknown>,
  zhSection: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  for (const key of keys) {
    expect([label, key, typeof section[key]]).toEqual([label, key, "string"])
    expect([label, key, typeof zhSection[key]]).toEqual([label, key, "string"])
  }
}

describe("cockpit dynamic translation keys", () => {
  it("covers every Squad review kind, recovery choice and waiting reason", () => {
    for (const kind of REVIEW_KINDS) {
      const enKind = (en.review.kinds as Record<string, Record<string, unknown>>)[kind]
      const zhKind = (zh.review.kinds as Record<string, Record<string, unknown>>)[kind]
      expect([kind, typeof enKind]).toEqual([kind, "object"])
      expect([kind, typeof zhKind]).toEqual([kind, "object"])
      expectKeys(enKind!, zhKind!, ["title", "description", "approve", "deny"], `review.${kind}`)
    }
    expectKeys(
      en.review.recovery.choices,
      zh.review.recovery.choices,
      RECOVERY_CHOICES,
      "agentRuns.review.recovery.choices"
    )
    expectKeys(en.waitingReasons, zh.waitingReasons, WAITING_REASONS, "agentRuns.waitingReasons")
  })

  it("covers every run-kind label in both locales", () => {
    expectKeys(en.kind, zh.kind, RUN_KIND_LABEL_KEYS, "agentRuns.kind")
  })

  it("covers every change-kind label, including any/gap/resync", () => {
    expectKeys(en.changeKind, zh.changeKind, CHANGE_KIND_LABEL_KEYS, "agentRuns.changeKind")
  })

  it("covers every status, status group and control verb", () => {
    expectKeys(en.status, zh.status, STATUSES, "agentRuns.status")
    expectKeys(en.filters, zh.filters, STATUS_GROUPS, "agentRuns.filters")
    expectKeys(en.actions, zh.actions, CONTROL_ACTIONS, "agentRuns.actions")
  })

  it("covers every activity category and status", () => {
    expectKeys(en.activityCategory, zh.activityCategory, ACTIVITY_CATEGORIES, "activityCategory")
    expectKeys(en.activityStatus, zh.activityStatus, ACTIVITY_STATUSES, "activityStatus")
  })

  it("covers every approval status and verification conclusion", () => {
    expectKeys(en.approvals, zh.approvals, INTERRUPT_STATUSES, "agentRuns.approvals")
    expectKeys(en.tests, zh.tests, CONCLUSIONS, "agentRuns.tests")
  })

  /** Every refusal the cockpit can surface needs something to say about it. */
  it("covers every control refusal and steer-degraded reason", () => {
    expectKeys(en.outcome, zh.outcome, OUTCOME_REASONS, "agentRuns.outcome")
    expectKeys(en.degraded, zh.degraded, DEGRADED_REASONS, "agentRuns.degraded")
  })

  /**
   * The monitor panel labels rows by their RAW kind, so the journal-only kinds
   * need entries there too or they render as `agent-turn` / `job`.
   */
  it("covers every filter kind in the execution monitor's own catalogue", () => {
    const camel: Record<string, string> = {
      "workflow-step": "workflowStep",
      "security-scan": "securityScan",
    }
    const keys = EXECUTION_FILTER_KINDS.map((kind) => camel[kind] ?? kind)
    expectKeys(enExecution.kind, zhExecution.kind, keys, "execution.kind")
    expectKeys(enExecution.kind, zhExecution.kind, ["agentTurn", "plan"], "execution.kind")
  })
})
