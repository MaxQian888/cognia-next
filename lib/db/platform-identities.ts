/**
 * CRUD for the platform identity directory.
 *
 * Absorbed identities remain addressable through recursive merge snapshots:
 * inbound traffic updates the matching snapshot and resolves to the surviving
 * primary instead of recreating a top-level duplicate.
 */

import Dexie from "dexie"

import type { PlatformKind } from "@/types/connectors/platform-kind"
import { recordTombstones } from "@/lib/sync/tombstones"

import type { PlatformIdentityRow } from "./connector-types"
import { getDb } from "./schema"

function newId(): string {
  return "pid_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface UpsertIdentityInput {
  platform: PlatformKind
  adapterId: string
  remoteUserId: string
  displayName?: string
  avatarUrl?: string
}

export type IdentityMergeFailureReason =
  | "same_identity"
  | "primary_missing"
  | "secondary_missing"
  | "primary_absorbed"
  | "secondary_absorbed"
  | "cycle"
  | "alias_conflict"

export type IdentityMergeResult =
  { ok: true; primary: PlatformIdentityRow } | { ok: false; reason: IdentityMergeFailureReason }

export type IdentityUnmergeFailureReason =
  "primary_missing" | "snapshot_missing" | "identity_conflict" | "alias_conflict"

export type IdentityUnmergeResult =
  | { ok: true; primary: PlatformIdentityRow; restored: PlatformIdentityRow }
  | { ok: false; reason: IdentityUnmergeFailureReason }

function identityKey(identity: Pick<PlatformIdentityRow, "platform" | "remoteUserId">): string {
  return `${identity.platform}\u0000${identity.remoteUserId}`
}

function flattenIdentityTree(identity: PlatformIdentityRow): PlatformIdentityRow[] {
  return [identity, ...(identity.mergedSnapshots ?? []).flatMap(flattenIdentityTree)]
}

function findInIdentityTree(
  identity: PlatformIdentityRow,
  predicate: (candidate: PlatformIdentityRow) => boolean
): PlatformIdentityRow | undefined {
  if (predicate(identity)) return identity
  for (const snapshot of identity.mergedSnapshots ?? []) {
    const found = findInIdentityTree(snapshot, predicate)
    if (found) return found
  }
  return undefined
}

function updateIdentityTree(
  identity: PlatformIdentityRow,
  predicate: (candidate: PlatformIdentityRow) => boolean,
  update: (candidate: PlatformIdentityRow) => PlatformIdentityRow
): { identity: PlatformIdentityRow; matched: boolean } {
  if (predicate(identity)) return { identity: update(identity), matched: true }
  let matched = false
  const mergedSnapshots = (identity.mergedSnapshots ?? []).map((snapshot) => {
    if (matched) return snapshot
    const nested = updateIdentityTree(snapshot, predicate, update)
    matched = nested.matched
    return nested.identity
  })
  return matched ? { identity: { ...identity, mergedSnapshots }, matched } : { identity, matched }
}

function hasDuplicateAliases(identity: PlatformIdentityRow): boolean {
  const ids = new Set<string>()
  const keys = new Set<string>()
  for (const candidate of flattenIdentityTree(identity)) {
    const key = identityKey(candidate)
    if (ids.has(candidate.id) || keys.has(key)) return true
    ids.add(candidate.id)
    keys.add(key)
  }
  return false
}

function treesOverlap(a: PlatformIdentityRow, b: PlatformIdentityRow): boolean {
  const aIds = new Set(flattenIdentityTree(a).map((identity) => identity.id))
  const aKeys = new Set(flattenIdentityTree(a).map(identityKey))
  return flattenIdentityTree(b).some(
    (identity) => aIds.has(identity.id) || aKeys.has(identityKey(identity))
  )
}

function findOwnerById(
  rows: readonly PlatformIdentityRow[],
  id: string
): PlatformIdentityRow | undefined {
  return rows.find((row) => findInIdentityTree(row, (candidate) => candidate.id === id))
}

/**
 * Create or update an identity. When the address belongs to an absorbed alias,
 * update that nested snapshot and return the surviving primary.
 */
export async function upsertIdentity(input: UpsertIdentityInput): Promise<PlatformIdentityRow> {
  const db = getDb()
  return db.transaction("rw", db.platformIdentities, async () => {
    const now = Date.now()
    const rows = await db.platformIdentities.toArray()
    const predicate = (identity: PlatformIdentityRow) =>
      identity.platform === input.platform && identity.remoteUserId === input.remoteUserId

    for (const row of rows) {
      const nested = updateIdentityTree(row, predicate, (identity) => ({
        ...identity,
        adapterId: input.adapterId,
        displayName: input.displayName ?? identity.displayName,
        avatarUrl: input.avatarUrl ?? identity.avatarUrl,
        lastSeenAt: now,
      }))
      if (!nested.matched) continue
      const primary = { ...nested.identity, lastSeenAt: now, updatedAt: now }
      await db.platformIdentities.put(primary)
      return primary
    }

    const row: PlatformIdentityRow = {
      id: newId(),
      platform: input.platform,
      adapterId: input.adapterId,
      remoteUserId: input.remoteUserId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      mergedFromIds: [],
      lastSeenAt: now,
      updatedAt: now,
    }
    await db.platformIdentities.add(row)
    return row
  })
}

/** Merge one top-level identity into another, preserving its complete tree. */
export async function mergeIdentities(
  primaryId: string,
  secondaryId: string
): Promise<IdentityMergeResult> {
  if (primaryId === secondaryId) return { ok: false, reason: "same_identity" }
  const db = getDb()
  // `syncTombstones` is in scope so the absorbed row's tombstone commits with
  // the delete. Outside the scope Dexie rejects the write and
  // `recordTombstones` swallows it, and the merge would never reach a client.
  return db.transaction("rw", db.platformIdentities, db.syncTombstones, async () => {
    const rows = await db.platformIdentities.toArray()
    const primary = rows.find((row) => row.id === primaryId)
    const secondary = rows.find((row) => row.id === secondaryId)
    if (!primary) {
      return {
        ok: false,
        reason: findOwnerById(rows, primaryId) ? "primary_absorbed" : "primary_missing",
      }
    }
    if (!secondary) {
      return {
        ok: false,
        reason: findOwnerById(rows, secondaryId) ? "secondary_absorbed" : "secondary_missing",
      }
    }
    if (findInIdentityTree(secondary, (identity) => identity.id === primaryId)) {
      return { ok: false, reason: "cycle" }
    }
    if (
      hasDuplicateAliases(primary) ||
      hasDuplicateAliases(secondary) ||
      treesOverlap(primary, secondary)
    ) {
      return { ok: false, reason: "alias_conflict" }
    }

    const absorbedIds = flattenIdentityTree(secondary).map((identity) => identity.id)
    const now = Date.now()
    const merged: PlatformIdentityRow = {
      ...primary,
      mergedFromIds: [...new Set([...(primary.mergedFromIds ?? []), ...absorbedIds])],
      mergedSnapshots: [...(primary.mergedSnapshots ?? []), secondary],
      lastSeenAt: Math.max(primary.lastSeenAt, secondary.lastSeenAt),
      updatedAt: now,
    }
    await db.platformIdentities.put(merged)
    await db.platformIdentities.delete(secondaryId)
    // The absorbed row is the one genuine deletion this directory performs;
    // without the tombstone a paired client would list the contact twice.
    await recordTombstones("platformIdentities", [secondaryId], now)
    return { ok: true, primary: merged }
  })
}

/** Restore one directly absorbed identity tree when all unique keys are free. */
export async function unmergeIdentity(
  primaryId: string,
  secondaryId: string
): Promise<IdentityUnmergeResult> {
  const db = getDb()
  return db.transaction("rw", db.platformIdentities, async () => {
    const primary = await db.platformIdentities.get(primaryId)
    if (!primary) return { ok: false, reason: "primary_missing" }
    const snapshot = (primary.mergedSnapshots ?? []).find((identity) => identity.id === secondaryId)
    if (!snapshot) return { ok: false, reason: "snapshot_missing" }
    if (hasDuplicateAliases(snapshot)) return { ok: false, reason: "alias_conflict" }

    const allRows = await db.platformIdentities.toArray()
    const restoredTree = flattenIdentityTree(snapshot)
    const restoredIds = new Set(restoredTree.map((identity) => identity.id))
    const restoredKeys = new Set(restoredTree.map(identityKey))
    const conflict = allRows.some(
      (row) =>
        row.id !== primaryId &&
        flattenIdentityTree(row).some(
          (identity) => restoredIds.has(identity.id) || restoredKeys.has(identityKey(identity))
        )
    )
    if (conflict) return { ok: false, reason: "identity_conflict" }

    const now = Date.now()
    const updated: PlatformIdentityRow = {
      ...primary,
      mergedFromIds: (primary.mergedFromIds ?? []).filter((id) => !restoredIds.has(id)),
      mergedSnapshots: (primary.mergedSnapshots ?? []).filter(
        (identity) => identity.id !== secondaryId
      ),
      updatedAt: now,
    }
    // The restored row keeps its own `lastSeenAt` (nobody saw it just now) but
    // is stamped as changed so it crosses to a paired client again.
    const restored: PlatformIdentityRow = { ...snapshot, updatedAt: now }
    await db.platformIdentities.put(updated)
    await db.platformIdentities.add(restored)
    return { ok: true, primary: updated, restored }
  })
}

export interface ContactGroup {
  primary: PlatformIdentityRow
  merged: PlatformIdentityRow[]
}

export async function listMergedGroups(): Promise<ContactGroup[]> {
  const all = await getDb().platformIdentities.toArray()
  return all
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((primary) => ({ primary, merged: primary.mergedSnapshots ?? [] }))
}

/** Return top-level identities that can safely be absorbed by this primary. */
export async function listMergeCandidates(primaryId: string): Promise<PlatformIdentityRow[]> {
  const rows = await getDb().platformIdentities.toArray()
  const primary = rows.find((row) => row.id === primaryId)
  if (!primary || hasDuplicateAliases(primary)) return []
  return rows
    .filter(
      (candidate) =>
        candidate.id !== primaryId &&
        !hasDuplicateAliases(candidate) &&
        !treesOverlap(primary, candidate)
    )
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

export async function listByAdapter(adapterId: string): Promise<PlatformIdentityRow[]> {
  const rows = await getDb()
    .platformIdentities.where("[adapterId+remoteUserId]")
    .between([adapterId, Dexie.minKey], [adapterId, Dexie.maxKey])
    .toArray()
  return rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

/** Resolve a top-level or absorbed platform address to its surviving primary. */
export async function getByPlatformUser(
  platform: PlatformKind,
  remoteUserId: string
): Promise<PlatformIdentityRow | undefined> {
  const rows = await getDb().platformIdentities.toArray()
  return rows.find((row) =>
    findInIdentityTree(
      row,
      (identity) => identity.platform === platform && identity.remoteUserId === remoteUserId
    )
  )
}
