// Notification V2 subscription contract.
//
// A subscription is an explicit, operator-authored route: which facts may
// reach which target, at which disclosure ceiling, with which overrides.
// There is deliberately no `enabledRules` field and no rule-id list — rules
// only ever tighten what the route would otherwise allow, so an
// allowlist-shaped field would grant nothing a default-deny route doesn't
// already cover. "Opt-in" rules are subscriptions.
//
// Authorization is modelled as an allowlist of policy-rule ids plus a quota —
// the rule list is checked at planning time, the quota is enforced on the
// delivery-intent write.

import type { NotificationScope } from "./scope"
import type { NotificationLevel } from "./index"
import type { NotificationCategory, NotificationPurpose } from "./decision"

/** A deny-first conditional override applied inside a subscription. */
export interface NotificationSubscriptionRule {
  /** `deny` wins over every other consideration; `defer` postpones to `until`. */
  kind: "deny" | "defer" | "suppress-if-unchanged" | "aggregate"
  /** Optional matcher — absent means the rule applies to every fact. */
  match?: {
    categories?: NotificationCategory[]
    minLevel?: NotificationLevel
    sources?: string[]
  }
  /** For `defer`: absolute epoch ms the fact is held until. */
  until?: number
  /** For `aggregate`: the digest bucket template override. */
  aggregateKeyTemplate?: string
}

export interface NotificationSubscription {
  id: string
  /** CAS version — bump on every mutation; send-time revalidation checks it. */
  version: number
  scope: NotificationScope
  /**
   * Denormalized `notificationScopeKey(scope)` — the indexed lookup column.
   * Writers keep it in lock-step with `scope` via `upsertNotificationSubscription`.
   */
  scopeKey: string
  /** The inbox owner this route serves. Defaults to `scope.accountId`. */
  principalId: string
  /**
   * The binding is structured, not a free-text matcher — each arm is a closed
   * union keyed on the stable identity of the producer:
   * - `run` — one execution run (`runId`)
   * - `source` — a producer family (`scheduler`, `agent-team`, …)
   * - `scope` — everything authorized inside this scope
   */
  binding: { kind: "run"; runId: string } | { kind: "source"; source: string } | { kind: "scope" }
  /**
   * Allowlist of policy-rule ids this route may evaluate. Absent = the
   * subscription's built-in pipeline only (no project rules). The rules
   * themselves live in the policy store; this is the grant, not the rule.
   */
  allowedPolicyRuleIds?: string[]
  /** Max external intents this route may mint per fact — quota enforcement. */
  maxIntentsPerFact?: number
  /** The targets this route may deliver to (target ids). */
  targetIds: string[]
  /** Route-level disclosure ceiling — intersected with each target's profile. */
  maxDisclosureProfileId: string
  /** Minimum level the route forwards — below it, the fact is `not-subscribed`. */
  minLevel: NotificationLevel
  /** Categories this route serves; absent = all categories. */
  categories?: NotificationCategory[]
  /** Purposes this route serves; absent = all purposes. */
  purposes?: NotificationPurpose[]
  enabled: boolean
  /** Numeric `enabled` projection for the `[scopeKey+enabledKey]` index. */
  enabledKey: 0 | 1
  /** Deny-first conditional overrides, evaluated in order. */
  rules: NotificationSubscriptionRule[]
  /** Digest template override for this route (`{scope}` `{taskId}` `{day}` …). */
  aggregateKeyTemplate?: string
  createdBy: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}
