// Local mirror of share links the owner has created. The worker is the source
// of truth for liveness (views / expiry / revocation); this table exists so the
// "My Shares" panel can list links, re-copy the full URL (which embeds the
// decryption key — only this device ever holds it), and drive revoke actions.
//
// `revoked` is a boolean, which IndexedDB doesn't index reliably, so it stays
// out of the index and is filtered in-memory (the v12 promptPresets precedent).

import { getDb } from "./schema"
import type { ShareKind } from "@/lib/share/types"

export interface SharedLinkRow {
  /** Local row id. */
  id: string
  /** Short code assigned by the worker; unique. */
  code: string
  kind: ShareKind
  /** Human title carried from the payload, for the list view. */
  title?: string
  /**
   * Full shareable URL including the `#fragment` decryption key. Persisted so
   * the owner can re-copy without re-encrypting; never leaves this device.
   */
  url: string
  createdAt: number
  /** Epoch ms; undefined ⇒ never expires. */
  expiresAt?: number
  maxViews?: number
  burnAfterRead: boolean
  hasPassphrase: boolean
  /** Owner-side revoke flag; the worker DELETE is authoritative. */
  revoked: boolean
}

function newId(): string {
  return "sl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Insert (or replace) the local mirror row for a created share. */
export async function recordSharedLink(
  partial: Omit<SharedLinkRow, "id" | "revoked"> & { id?: string; revoked?: boolean }
): Promise<SharedLinkRow> {
  const row: SharedLinkRow = {
    id: partial.id ?? newId(),
    code: partial.code,
    kind: partial.kind,
    title: partial.title,
    url: partial.url,
    createdAt: partial.createdAt,
    expiresAt: partial.expiresAt,
    maxViews: partial.maxViews,
    burnAfterRead: partial.burnAfterRead,
    hasPassphrase: partial.hasPassphrase,
    revoked: partial.revoked ?? false,
  }
  await getDb().sharedLinks.put(row)
  return row
}

/** Newest-first list, optionally hiding revoked rows. */
export async function listSharedLinks(opts?: {
  includeRevoked?: boolean
}): Promise<SharedLinkRow[]> {
  const rows = await getDb().sharedLinks.orderBy("createdAt").reverse().toArray()
  return opts?.includeRevoked ? rows : rows.filter((r) => !r.revoked)
}

export async function getSharedLinkByCode(code: string): Promise<SharedLinkRow | undefined> {
  return getDb().sharedLinks.where("code").equals(code).first()
}

/** Flip the local revoke flag. The caller is responsible for the worker DELETE. */
export async function markSharedLinkRevoked(code: string): Promise<void> {
  await getDb().sharedLinks.where("code").equals(code).modify({ revoked: true })
}

export async function deleteSharedLink(code: string): Promise<void> {
  await getDb().sharedLinks.where("code").equals(code).delete()
}

/** Drop rows whose `expiresAt` is in the past. Returns the number removed. */
export async function pruneExpiredSharedLinks(now = Date.now()): Promise<number> {
  const db = getDb()
  const expired = await db.sharedLinks.where("expiresAt").below(now).primaryKeys()
  if (expired.length > 0) await db.sharedLinks.bulkDelete(expired as string[])
  return expired.length
}
