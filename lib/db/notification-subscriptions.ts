// Dexie CRUD for Notification V2 subscriptions (v227).
//
// A subscription is the explicit route: binding (run/source/scope) → target
// set, with a disclosure ceiling, min level, category/purpose filters and a
// deny-first ruleset. The planner reads the enabled candidate set for a
// scope, matches each subscription's binding against the fact, and evaluates
// the route's rules in order — the DB layer only stores and returns rows;
// matching/evaluation is pure (`lib/notifications/policy/*`).

import { nanoid } from "nanoid"
import { getDb } from "./schema"
import { scopeKeyOf } from "@/types/notifications/scope"
import type { NotificationSubscription } from "@/types/notifications/subscription"

export type { NotificationSubscription }

export interface UpsertNotificationSubscriptionInput {
  id?: string
  scope: NotificationSubscription["scope"]
  principalId: string
  binding: NotificationSubscription["binding"]
  targetIds: string[]
  maxDisclosureProfileId: string
  minLevel: NotificationSubscription["minLevel"]
  categories?: NotificationSubscription["categories"]
  purposes?: NotificationSubscription["purposes"]
  enabled: boolean
  rules?: NotificationSubscription["rules"]
  allowedPolicyRuleIds?: string[]
  maxIntentsPerFact?: number
  aggregateKeyTemplate?: string
  createdBy: string
  expectedVersion?: number
}

/** Create or CAS-update a subscription. Throws `subscription-version-conflict`. */
export async function upsertNotificationSubscription(
  input: UpsertNotificationSubscriptionInput
): Promise<NotificationSubscription> {
  const db = getDb()
  const now = Date.now()
  return db.transaction("rw", db.notificationSubscriptions, async () => {
    const existing = input.id ? await db.notificationSubscriptions.get(input.id) : undefined
    if (
      input.expectedVersion !== undefined &&
      existing &&
      existing.version !== input.expectedVersion
    ) {
      throw new Error("subscription-version-conflict")
    }
    const next: NotificationSubscription = {
      id: input.id ?? existing?.id ?? nanoid(),
      version: (existing?.version ?? 0) + 1,
      scope: input.scope,
      scopeKey: scopeKeyOf(input.scope),
      principalId: input.principalId,
      binding: input.binding,
      targetIds: input.targetIds,
      maxDisclosureProfileId: input.maxDisclosureProfileId,
      minLevel: input.minLevel,
      ...(input.categories ? { categories: input.categories } : {}),
      ...(input.purposes ? { purposes: input.purposes } : {}),
      enabled: input.enabled,
      enabledKey: input.enabled ? 1 : 0,
      rules: input.rules ?? [],
      ...(input.allowedPolicyRuleIds ? { allowedPolicyRuleIds: input.allowedPolicyRuleIds } : {}),
      ...(input.maxIntentsPerFact !== undefined
        ? { maxIntentsPerFact: input.maxIntentsPerFact }
        : {}),
      ...(input.aggregateKeyTemplate ? { aggregateKeyTemplate: input.aggregateKeyTemplate } : {}),
      createdBy: existing?.createdBy ?? input.createdBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.deletedAt ? { deletedAt: existing.deletedAt } : {}),
    }
    await db.notificationSubscriptions.put(next)
    return next
  })
}

export async function getNotificationSubscription(
  id: string
): Promise<NotificationSubscription | undefined> {
  return getDb().notificationSubscriptions.get(id)
}

/** Enabled, non-deleted subscriptions in a scope — the planner's route set. */
export async function listEnabledNotificationSubscriptions(
  scopeKey: string
): Promise<NotificationSubscription[]> {
  return getDb()
    .notificationSubscriptions.where("[scopeKey+enabledKey]")
    .equals([scopeKey, 1])
    .filter((s) => s.deletedAt === undefined)
    .toArray()
}

/** All non-deleted subscriptions in a scope — management views. */
export async function listNotificationSubscriptions(
  scopeKey: string
): Promise<NotificationSubscription[]> {
  return getDb()
    .notificationSubscriptions.where("scopeKey")
    .equals(scopeKey)
    .filter((s) => s.deletedAt === undefined)
    .toArray()
}

/** Subscriptions that route to a given target — revocation cascade reads. */
export async function listSubscriptionsForTarget(
  scopeKey: string,
  targetId: string
): Promise<NotificationSubscription[]> {
  return getDb()
    .notificationSubscriptions.where("targetIds")
    .equals(targetId)
    .filter((s) => s.scopeKey === scopeKey && s.deletedAt === undefined)
    .toArray()
}

/** Soft-delete — bumps `version` so pending intents revalidate as revoked. */
export async function deleteNotificationSubscription(
  id: string,
  expectedVersion?: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.notificationSubscriptions, async () => {
    const existing = await db.notificationSubscriptions.get(id)
    if (!existing) return
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new Error("subscription-version-conflict")
    }
    await db.notificationSubscriptions.put({
      ...existing,
      version: existing.version + 1,
      enabled: false,
      enabledKey: 0,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
}
