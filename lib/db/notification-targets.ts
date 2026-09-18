// Dexie CRUD + resolution for Notification V2 delivery targets (v227).
//
// A target is ONE canonical external destination plus its consent grant.
// Two write paths are deliberately different:
//   • `upsertNotificationTarget` — operator/ settings writes, CAS-guarded on
//     `version`, keeps `enabledKey` in lock-step with `enabled`.
//   • `resolveNotificationTarget` — the planner's read: disabled / soft-
//     deleted targets still RETURN (so the decision can be `denied-by-target`
//     rather than `route-missing`), which is the audit distinction.
//
// The `addressFingerprint` is the canonical dedupe handle — two alias rows
// naming the same group chat share it, so the delivery-slot key collapses
// them into ONE destination. Webhook fingerprints come from the credential
// layer (endpoint identity), never the URL secret itself.

import { nanoid } from "nanoid"
import { getDb } from "./schema"
import { scopeKeyOf } from "@/types/notifications/scope"
import type { NotificationTarget, NotificationTargetAddress } from "@/types/notifications/target"

export type { NotificationTarget, NotificationTargetAddress }

/** Compute the canonical fingerprint for a target address. */
export function notificationTargetFingerprint(address: NotificationTargetAddress): string {
  if (address.kind === "connector") {
    const region = address.region ?? "feishu"
    // Canonical destination = adapter instance + region + the platform's own
    // container/topic identity (the group chat or DM + thread), NOT the
    // delivery handle or credentials. Two alias rows pointing at the same
    // `containerId`/`topicId` collapse to one destination.
    const container = address.deliveryTarget.address.containerId
    const topic = address.deliveryTarget.address.topicId ?? ""
    const conv = address.conversationKey ?? address.deliveryTarget.address.conversationKey ?? ""
    return `connector:${address.adapterId}:${region}:${container}:${topic}:${conv}`
  }
  // Webhook — the credential layer owns the endpoint identity; we fingerprint
  // the REFERENCE (opaque, secret-free), so two refs to one endpoint collapse.
  return `feishu-webhook:${address.region}:${address.endpointSecretRef}`
}

export interface UpsertNotificationTargetInput {
  id?: string
  scope: NotificationTarget["scope"]
  label: string
  address: NotificationTargetAddress
  enabled: boolean
  consent: NotificationTarget["consent"]
  disclosureProfileId: string
  locale: string
  timezone: string
  /** Expected current version for CAS; omit to force-create. */
  expectedVersion?: number
}

/**
 * Create or CAS-update a target. Address changes mint a fresh fingerprint and
 * bump `version`, which is what makes a pending intent replan detect a moved
 * destination. Throws `target-version-conflict` on a stale `expectedVersion`.
 */
export async function upsertNotificationTarget(
  input: UpsertNotificationTargetInput
): Promise<NotificationTarget> {
  const db = getDb()
  const now = Date.now()
  return db.transaction("rw", db.notificationTargets, async () => {
    const existing = input.id ? await db.notificationTargets.get(input.id) : undefined
    if (
      input.expectedVersion !== undefined &&
      existing &&
      existing.version !== input.expectedVersion
    ) {
      throw new Error("target-version-conflict")
    }
    const next: NotificationTarget = {
      id: input.id ?? existing?.id ?? nanoid(),
      version: (existing?.version ?? 0) + 1,
      scope: input.scope,
      scopeKey: scopeKeyOf(input.scope),
      label: input.label,
      address: input.address,
      addressFingerprint: notificationTargetFingerprint(input.address),
      enabled: input.enabled,
      enabledKey: input.enabled ? 1 : 0,
      consent: input.consent,
      disclosureProfileId: input.disclosureProfileId,
      locale: input.locale,
      timezone: input.timezone,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.deletedAt ? { deletedAt: existing.deletedAt } : {}),
    }
    await db.notificationTargets.put(next)
    return next
  })
}

/** Read a target by id — includes disabled and soft-deleted rows. */
export async function getNotificationTarget(id: string): Promise<NotificationTarget | undefined> {
  return getDb().notificationTargets.get(id)
}

/** All enabled, non-deleted targets in a scope — the planner's candidate set. */
export async function listEnabledNotificationTargets(
  scopeKey: string
): Promise<NotificationTarget[]> {
  return getDb()
    .notificationTargets.where("[scopeKey+enabledKey]")
    .equals([scopeKey, 1])
    .filter((t) => t.deletedAt === undefined)
    .toArray()
}

/** Every non-deleted target in a scope (enabled or not) — management views. */
export async function listNotificationTargets(scopeKey: string): Promise<NotificationTarget[]> {
  return getDb()
    .notificationTargets.where("scopeKey")
    .equals(scopeKey)
    .filter((t) => t.deletedAt === undefined)
    .toArray()
}

/** Targets sharing one canonical destination — alias detection for slots. */
export async function listTargetsByFingerprint(
  scopeKey: string,
  addressFingerprint: string
): Promise<NotificationTarget[]> {
  return getDb()
    .notificationTargets.where("scopeKey")
    .equals(scopeKey)
    .filter((t) => t.addressFingerprint === addressFingerprint && t.deletedAt === undefined)
    .toArray()
}

/**
 * Soft-delete — the row stays (audit trail + intent revalidation reads it as
 * `target-deleted`) but `deletedAt` removes it from every candidate list.
 * CAS-guarded; bumps `version` so pending intents see the revocation.
 */
export async function deleteNotificationTarget(
  id: string,
  expectedVersion?: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.notificationTargets, async () => {
    const existing = await db.notificationTargets.get(id)
    if (!existing) return
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new Error("target-version-conflict")
    }
    await db.notificationTargets.put({
      ...existing,
      version: existing.version + 1,
      enabled: false,
      enabledKey: 0,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
}

/**
 * The scope key a target lives under — helper for callers that hold the
 * scope object rather than the key.
 */
export function scopeKeyOfTarget(target: NotificationTarget): string {
  return scopeKeyOf(target.scope)
}
