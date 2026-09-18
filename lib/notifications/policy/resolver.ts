// Notification V2 route resolver — the DB→planner bridge.
//
// The planner is pure; the resolver gathers its inputs. For a fact it loads
// the scope's enabled subscriptions, the union of their referenced targets,
// the open incidents, and the fact's prior intents — then hands the whole
// set to `planNotification` and returns the closed decision.
//
// This is also the seam the projection worker uses to re-plan: it re-reads
// the SAME inputs at send-commit time so a target/subscription that moved
// between plan and commit is re-validated, never trusted stale.

import type { CogniaDB } from "@/lib/db/schema"
import { listEnabledNotificationSubscriptions } from "@/lib/db/notification-subscriptions"
import { getNotificationTarget } from "@/lib/db/notification-targets"
import { listOpenIncidents } from "@/lib/db/notification-policy-state"
import { listIntentsForNotification } from "@/lib/db/notification-delivery"
import type { NotificationTarget } from "@/types/notifications/target"
import type {
  NotificationDecision,
  NotificationPolicyContext,
} from "@/types/notifications/decision"
import { planNotification, type PlannerFact, type PlannerInput } from "./planner"

/** Gather the planner's inputs for a fact and produce its decision. */
export async function resolveNotificationPlan(input: {
  fact: PlannerFact
  scopeKey: string
  policy: NotificationPolicyContext
  /** Prior intents — pass when already loaded (the projector's cursor read). */
  priorIntents?: PlannerInput["priorIntents"]
  /** Pre-resolved targets — a caller that already fetched them (batch). */
  targetOverrides?: ReadonlyMap<string, NotificationTarget>
  now?: number
}): Promise<NotificationDecision> {
  const now = input.now ?? Date.now()
  const [subscriptions, incidents, priorIntents] = await Promise.all([
    listEnabledNotificationSubscriptions(input.scopeKey),
    listOpenIncidents(input.scopeKey),
    input.priorIntents !== undefined
      ? Promise.resolve(input.priorIntents)
      : input.fact.notificationId
        ? listIntentsForNotification(input.fact.notificationId)
        : Promise.resolve([]),
  ])

  // Resolve the union of referenced targets — enabled or not, the planner
  // needs the row to return `denied-by-target` vs `route-missing`.
  const targetIds = new Set<string>()
  for (const sub of subscriptions) for (const id of sub.targetIds) targetIds.add(id)
  const targets =
    input.targetOverrides ??
    new Map(
      (await Promise.all([...targetIds].map((id) => getNotificationTarget(id))))
        .filter((t): t is NotificationTarget => t !== undefined)
        .map((t) => [t.id, t] as const)
    )

  return planNotification({
    fact: input.fact,
    subscriptions,
    targets,
    incidents,
    priorIntents,
    policy: input.policy,
    now,
  })
}

/**
 * Re-validate ONE route at send-commit time — the second half of the
//   projection CAS. Reads the CURRENT target + subscription versions and the
//   fact's current validity, so a send that was authorized at plan time but
//   revoked before commit is refused here, not discovered post-send.
 */
export async function revalidateRouteAtCommit(input: {
  targetId: string
  subscriptionId?: string
  expectedTargetVersion: number
  expectedSubscriptionVersion?: number
  txDb: CogniaDB
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { txDb } = input
  const target = await txDb.notificationTargets.get(input.targetId)
  if (!target || target.deletedAt !== undefined || !target.enabled) {
    return { ok: false, reason: "target-revoked" }
  }
  if (target.version !== input.expectedTargetVersion) {
    return { ok: false, reason: "target-version-moved" }
  }
  if (input.subscriptionId && input.expectedSubscriptionVersion !== undefined) {
    const sub = await txDb.notificationSubscriptions.get(input.subscriptionId)
    if (!sub || sub.deletedAt !== undefined || !sub.enabled) {
      return { ok: false, reason: "subscription-revoked" }
    }
    if (sub.version !== input.expectedSubscriptionVersion) {
      return { ok: false, reason: "subscription-version-moved" }
    }
  }
  return { ok: true }
}
