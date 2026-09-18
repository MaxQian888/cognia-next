// Notification V2 planner — the pure decision function.
//
// Given ONE fact and the durable inputs (subscriptions, targets, incidents,
// prior intents, policy context), produce a `NotificationDecision` — a closed
// verdict per (subscription, target) route. The planner is pure: it performs
// no I/O and no clock reads beyond the injected `now`, so it is trivially
// testable and safe to call inside the projection transaction's plan phase.
//
// Evaluation order (deny-first, then schedule, then emit):
//   A. Expiry        — an expired fact is `expired`, full stop.
//   B. Subscription  — binding + category + purpose + level + principal gate
//                      each route; no match ⇒ `not-subscribed`.
//   C. Target        — enabled / not-deleted / consent / capability / the
//                      route+target disclosure ceiling.
//   D. Route rules   — deny-first; then defer / suppress-if-unchanged /
//                      aggregate (the subscription's own closed rule set).
//   E. Quiet hours   — defer into the target's release instant.
//   F. Suppression   — incident inhibition, materially-unchanged, ack.
//   G. Emit          — `notified` with the resolved disclosure level.
//
// Every verdict carries a structured `reasonCode` so the audit trail can
// distinguish "nothing configured" from "denied" from "deferred".

import type {
  NotificationDecision,
  NotificationDecisionKind,
  NotificationDecisionReasonCode,
  NotificationRouteDecision,
  NotificationCategory,
  NotificationPurpose,
  NotificationPolicyContext,
} from "@/types/notifications/decision"
import type { NotificationSubscription } from "@/types/notifications/subscription"
import type {
  NotificationTarget,
  NotificationDisclosureProfile,
} from "@/types/notifications/target"
import { disclosureProfileById, NOTIFICATION_DISCLOSURE_RANK } from "@/types/notifications/target"
import type { NotificationPolicyStateRow } from "@/types/notifications/decision"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"
import type { NotificationLevel } from "@/types/notifications"
import { NOTIFICATION_LEVEL_RANK } from "@/types/notifications"
import { evaluateQuietHours } from "./quiet-hours"
import { stableHash } from "../result/materiality"

/** The fact the planner evaluates — a normalized view of the notification. */
export interface PlannerFact {
  /** Stable identity — `logicalKey` or the record id. */
  factKey: string
  notificationId?: string
  category: NotificationCategory
  purpose: NotificationPurpose
  level: NotificationLevel
  source: string
  /** The run this fact belongs to, for `run`-bound subscriptions. */
  runId?: string
  /** The principal the fact is for (defaults to scope account). */
  principalId?: string
  /** The fact's semantic material hash (suppress-if-unchanged input). */
  materialHash?: string
  /** Expiry deadline — an expired fact never delivers. */
  validUntil?: number
  /** The classification the producer stamped (before target clipping). */
  maxClassification?: string
}

export interface PlannerInput {
  fact: PlannerFact
  /** Enabled subscriptions in the fact's scope. */
  subscriptions: readonly NotificationSubscription[]
  /** All targets referenced by those subscriptions (id → row). */
  targets: ReadonlyMap<string, NotificationTarget>
  /** Open incidents in the scope (inhibition suppression). */
  incidents: readonly NotificationPolicyStateRow[]
  /** Prior intents for this fact's slot (materiality + dedupe baselines). */
  priorIntents: readonly NotificationDeliveryIntent[]
  /** The durable policy context (quiet hours, thresholds, version). */
  policy: NotificationPolicyContext
  /** Disclosure profiles the targets resolve against. */
  disclosureProfiles?: readonly NotificationDisclosureProfile[]
  now: number
}

const LEVEL_RANK = NOTIFICATION_LEVEL_RANK

/** The decision-outcome severity order — lower index wins `outcome`. */
const OUTCOME_ORDER: readonly NotificationDecisionKind[] = [
  "notified",
  "pending-approval",
  "deferred",
  "digest",
  "duplicate",
  "suppressed",
  "not-subscribed",
  "denied-by-target",
  "denied-by-policy",
  "expired",
]

/** Plan one fact → a closed decision. Pure. */
export function planNotification(input: PlannerInput): NotificationDecision {
  const { fact, now } = input
  const routes: NotificationRouteDecision[] = []

  // A. Expiry — short-circuits every route.
  if (fact.validUntil !== undefined && fact.validUntil <= now) {
    return decision(fact, input, [
      {
        subscriptionId: "",
        targetId: "",
        kind: "expired",
        reasonCode: "expires-at-past",
      },
    ])
  }

  // B. Subscription match — collect routes that bind this fact.
  const matched = input.subscriptions.filter((sub) => bindingMatches(sub, fact))
  if (matched.length === 0) {
    return decision(fact, input, [
      { subscriptionId: "", targetId: "", kind: "not-subscribed", reasonCode: "route-missing" },
    ])
  }

  for (const sub of matched) {
    // Route-level gates — a failed gate yields one not-subscribed verdict per
    // route (no per-target fan-out, since the route itself refuses).
    const gate = routeGate(sub, fact)
    if (gate) {
      routes.push({
        subscriptionId: sub.id,
        targetId: "",
        kind: "not-subscribed",
        reasonCode: gate,
      })
      continue
    }

    for (const targetId of sub.targetIds) {
      routes.push(evaluateRoute(sub, targetId, input))
    }
  }

  return decision(fact, input, routes)
}

/** Does a subscription's binding name this fact? */
function bindingMatches(sub: NotificationSubscription, fact: PlannerFact): boolean {
  switch (sub.binding.kind) {
    case "run":
      return fact.runId !== undefined && sub.binding.runId === fact.runId
    case "source":
      return sub.binding.source === fact.source
    case "scope":
      return true
  }
}

/** Route-level refusal — returns the reasonCode or null when the gate passes. */
function routeGate(
  sub: NotificationSubscription,
  fact: PlannerFact
): NotificationDecisionReasonCode | null {
  if (!sub.enabled) return "route-disabled"
  if (fact.principalId && sub.principalId !== fact.principalId) return "principal-mismatch"
  if (sub.categories && !sub.categories.includes(fact.category)) return "category-not-served"
  if (sub.purposes && !sub.purposes.includes(fact.purpose)) return "purpose-not-served"
  if (LEVEL_RANK[fact.level] < LEVEL_RANK[sub.minLevel]) return "below-min-level"
  return null
}

/** Evaluate one (subscription, target) route through the deny-first order. */
function evaluateRoute(
  sub: NotificationSubscription,
  targetId: string,
  input: PlannerInput
): NotificationRouteDecision {
  const { fact, now } = input
  const target = input.targets.get(targetId)

  // C. Target checks.
  if (!target) {
    return verdict(sub, targetId, "denied-by-target", "target-disabled")
  }
  if (target.deletedAt !== undefined) {
    return verdict(sub, targetId, "denied-by-target", "target-deleted")
  }
  if (!target.enabled) {
    return verdict(sub, targetId, "denied-by-target", "target-disabled")
  }
  // Consent: `proactive` authorizes every push; `origin-reply` only answers a
  // notification that originated in this conversation (approval requests).
  if (target.consent.mode !== "proactive" && fact.purpose !== "approval-request") {
    return verdict(sub, targetId, "denied-by-target", "consent-mode-origin-only")
  }

  // Disclosure ceiling: route ∩ target — the narrower wins, never widened.
  // `effectiveProfileId` rides the verdict so the render clips at this
  // profile, not the wider target profile (a public-capped subscription emits
  // counts-only even to an internal conversation).
  const effectiveProfile = narrowerProfile(
    sub.maxDisclosureProfileId,
    target.disclosureProfileId,
    input.disclosureProfiles
  )
  const profile = disclosureProfileById(effectiveProfile, input.disclosureProfiles)

  // D. Route rules — deny-first, then defer/aggregate/suppress-if-unchanged.
  for (const rule of sub.rules) {
    if (!ruleMatches(rule, fact)) continue
    if (rule.kind === "deny") {
      return verdict(sub, targetId, "denied-by-policy", "policy-rule-deny")
    }
    if (rule.kind === "defer") {
      return {
        subscriptionId: sub.id,
        targetId,
        kind: "deferred",
        reasonCode: "explicit-defer-rule",
        deferredUntil: rule.until,
        disclosureLevel: profile.maxLevel,
        effectiveProfileId: effectiveProfile,
      }
    }
    if (rule.kind === "aggregate") {
      return {
        subscriptionId: sub.id,
        targetId,
        kind: "digest",
        reasonCode: "aggregated-into-bucket",
        aggregateKey: renderAggregateKey(
          sub.aggregateKeyTemplate ?? rule.aggregateKeyTemplate,
          fact,
          input
        ),
        disclosureLevel: profile.maxLevel,
        effectiveProfileId: effectiveProfile,
      }
    }
    if (rule.kind === "suppress-if-unchanged" && fact.materialHash) {
      const dup = input.priorIntents.find(
        (i) => i.status === "accepted" && i.payload.contentHash === fact.materialHash
      )
      if (dup) {
        return verdict(sub, targetId, "suppressed", "materially-unchanged", {
          disclosureLevel: profile.maxLevel,
          effectiveProfileId: effectiveProfile,
        })
      }
    }
  }

  // Quota — a route may not mint more than maxIntentsPerFact for one fact.
  if (sub.maxIntentsPerFact !== undefined) {
    const minted = input.priorIntents.filter((i) => i.subscriptionId === sub.id).length
    if (minted >= sub.maxIntentsPerFact) {
      return verdict(sub, targetId, "denied-by-policy", "quota-exceeded")
    }
  }

  // E. Quiet hours — defer into the target's release instant.
  const qh = evaluateQuietHours({
    instant: now,
    window: {
      enabled: input.policy.quietHoursEnabled,
      start: input.policy.quietHoursStart,
      end: input.policy.quietHoursEnd,
    },
    timezone: input.policy.quietHoursTimezone ?? target.timezone ?? input.policy.timezone,
    level: fact.level,
    allowCritical: input.policy.quietHoursAllowCritical,
  })
  if (qh.deferred) {
    return {
      subscriptionId: sub.id,
      targetId,
      kind: "deferred",
      reasonCode: "quiet-hours",
      deferredUntil: qh.releaseAt,
      disclosureLevel: profile.maxLevel,
      effectiveProfileId: effectiveProfile,
    }
  }

  // F. Suppression — incident inhibition. A fact folded into an open incident
  // (whose root it isn't) is suppressed while the incident is open.
  const inhibition = input.incidents.find(
    (inc) =>
      inc.incident &&
      inc.incident.state === "open" &&
      inc.incident.memberFactKeys.includes(fact.factKey) &&
      inc.incident.rootFactKey !== fact.factKey
  )
  if (inhibition) {
    return verdict(sub, targetId, "suppressed", "inhibited-by-incident", {
      disclosureLevel: profile.maxLevel,
      effectiveProfileId: effectiveProfile,
    })
  }

  // Duplicate — an already-accepted send of this exact content on this slot.
  const dupSend = input.priorIntents.find(
    (i) =>
      i.targetId === targetId &&
      i.status === "accepted" &&
      fact.materialHash !== undefined &&
      i.payload.contentHash === fact.materialHash
  )
  if (dupSend) {
    return verdict(sub, targetId, "duplicate", "same-content-accepted", {
      disclosureLevel: profile.maxLevel,
      effectiveProfileId: effectiveProfile,
    })
  }

  // G. Emit.
  return {
    subscriptionId: sub.id,
    targetId,
    kind: "notified",
    reasonCode: "routed",
    disclosureLevel: profile.maxLevel,
    effectiveProfileId: effectiveProfile,
  }
}

function ruleMatches(rule: NotificationSubscription["rules"][number], fact: PlannerFact): boolean {
  const m = rule.match
  if (!m) return true
  if (m.categories && !m.categories.includes(fact.category)) return false
  if (m.minLevel && LEVEL_RANK[fact.level] < LEVEL_RANK[m.minLevel]) return false
  if (m.sources && !m.sources.includes(fact.source)) return false
  return true
}

function narrowerProfile(
  a: string,
  b: string,
  profiles?: readonly NotificationDisclosureProfile[]
): string {
  const pa = disclosureProfileById(a, profiles)
  const pb = disclosureProfileById(b, profiles)
  return NOTIFICATION_DISCLOSURE_RANK[pa.maxLevel] <= NOTIFICATION_DISCLOSURE_RANK[pb.maxLevel]
    ? pa.id
    : pb.id
}

function renderAggregateKey(
  template: string | undefined,
  fact: PlannerFact,
  input: PlannerInput
): string {
  const day = new Date(input.now).toISOString().slice(0, 10)
  const base = (template ?? "{scope}:{category}:{day}")
    .replace("{scope}", input.fact.factKey.split(":")[0] ?? "scope")
    .replace("{category}", fact.category)
    .replace("{taskId}", fact.runId ?? "none")
    .replace("{day}", day)
  return `${base}:${stableHash({ s: input.policy.policyVersion, f: fact.factKey }).slice(0, 8)}`
}

function verdict(
  sub: NotificationSubscription,
  targetId: string,
  kind: NotificationDecisionKind,
  reasonCode: NotificationDecisionReasonCode,
  extra: Partial<NotificationRouteDecision> = {}
): NotificationRouteDecision {
  return { subscriptionId: sub.id, targetId, kind, reasonCode, ...extra }
}

function decision(
  fact: PlannerFact,
  input: PlannerInput,
  routes: NotificationRouteDecision[]
): NotificationDecision {
  const best = routes.reduce<NotificationDecisionKind>(
    (acc, r) => (OUTCOME_ORDER.indexOf(r.kind) < OUTCOME_ORDER.indexOf(acc) ? r.kind : acc),
    "expired" // worst default; every real kind beats it
  )
  return {
    factKey: fact.factKey,
    category: fact.category,
    revision: (input.priorIntents[0]?.decisionRevision ?? 0) + 1,
    routes,
    outcome: best,
    evidence: {
      policyVersion: input.policy.policyVersion,
      evaluatedAt: input.now,
      inputHash: stableHash({
        f: fact.factKey,
        c: fact.category,
        m: fact.materialHash,
        n: routes.length,
      }),
    },
  }
}
