// Local mirror of share links the owner has created. The worker is the source
// of truth for liveness (views / expiry / revocation); this table exists so the
// "My Shares" panel can list links, re-copy the full URL (which embeds the
// decryption key — only this device ever holds it), and drive revoke actions.
//
// `revoked` is a boolean, which IndexedDB doesn't index reliably, so it stays
// out of the index and is filtered in-memory (the v12 promptPresets precedent).

import { getDb } from "./schema"
import type { ShareKind } from "@/lib/share/types"
import { createKeyringStore } from "@/lib/credentials/keyring-store"

const secretStore = createKeyringStore("share-links")

interface SharedLinkSecretRefs {
  urlFragment?: string
  ownerToken?: string
}

export interface SharedLinkRow {
  /** Local row id. */
  id: string
  /** Short code assigned by the worker; unique. */
  code: string
  kind: ShareKind
  /** Human title carried from the payload, for the list view. */
  title?: string
  /** Non-secret local namespace used by the creating domain for revocation. */
  ownerScope?: string
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
  /**
   * Per-share owner secret returned by the worker at create time. Required to
   * call stats/delete on a multi-tenant deployment. Stays on this device only
   * (never in the shareable URL). Undefined for rows created before this field
   * existed — those fall back to the worker's upload-secret gate.
   */
  ownerToken?: string
  /** References into the encrypted credential store; never sent to callers intentionally. */
  secretRefs?: SharedLinkSecretRefs
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
  const id = partial.id ?? newId()
  const { baseUrl, fragment } = splitShareUrl(partial.url)
  const secretRefs: SharedLinkSecretRefs = {}
  if (fragment) {
    secretRefs.urlFragment = `${id}:url-fragment`
    await secretStore.save(secretRefs.urlFragment, fragment)
  }
  if (partial.ownerToken) {
    secretRefs.ownerToken = `${id}:owner-token`
    await secretStore.save(secretRefs.ownerToken, partial.ownerToken)
  }
  const row: SharedLinkRow = {
    id,
    code: partial.code,
    kind: partial.kind,
    title: partial.title,
    ownerScope: partial.ownerScope,
    url: baseUrl,
    createdAt: partial.createdAt,
    expiresAt: partial.expiresAt,
    maxViews: partial.maxViews,
    burnAfterRead: partial.burnAfterRead,
    hasPassphrase: partial.hasPassphrase,
    secretRefs: Object.keys(secretRefs).length > 0 ? secretRefs : undefined,
    revoked: partial.revoked ?? false,
  }
  await getDb().sharedLinks.put(row)
  return publicSharedLink(row, partial.url, partial.ownerToken)
}

/** Newest-first list, optionally hiding revoked rows. */
export async function listSharedLinks(opts?: {
  includeRevoked?: boolean
}): Promise<SharedLinkRow[]> {
  const rows = await getDb().sharedLinks.orderBy("createdAt").reverse().toArray()
  const visible = opts?.includeRevoked ? rows : rows.filter((r) => !r.revoked)
  return Promise.all(visible.map(hydrateSharedLink))
}

export async function getSharedLinkByCode(code: string): Promise<SharedLinkRow | undefined> {
  const row = await getDb().sharedLinks.where("code").equals(code).first()
  return row ? hydrateSharedLink(row) : undefined
}

/** Flip the local revoke flag. The caller is responsible for the worker DELETE. */
export async function markSharedLinkRevoked(code: string): Promise<void> {
  await getDb().sharedLinks.where("code").equals(code).modify({ revoked: true })
}

/** Update the local mirror's cached expiry after a successful worker renew. */
export async function updateSharedLinkExpiry(code: string, expiresAt: number): Promise<void> {
  await getDb().sharedLinks.where("code").equals(code).modify({ expiresAt })
}

export async function deleteSharedLink(code: string): Promise<void> {
  const row = await getDb().sharedLinks.where("code").equals(code).first()
  await getDb().sharedLinks.where("code").equals(code).delete()
  if (row) await deleteSharedLinkSecrets(row)
}

/** Drop rows whose `expiresAt` is in the past. Returns the number removed. */
export async function pruneExpiredSharedLinks(now = Date.now()): Promise<number> {
  const db = getDb()
  const expired = await db.sharedLinks.where("expiresAt").below(now).toArray()
  if (expired.length > 0) {
    await db.sharedLinks.bulkDelete(expired.map((row) => row.id))
    await Promise.all(expired.map(deleteSharedLinkSecrets))
  }
  return expired.length
}

function splitShareUrl(url: string): { baseUrl: string; fragment: string } {
  const hash = url.indexOf("#")
  return hash === -1
    ? { baseUrl: url, fragment: "" }
    : { baseUrl: url.slice(0, hash), fragment: url.slice(hash) }
}

async function hydrateSharedLink(row: SharedLinkRow): Promise<SharedLinkRow> {
  if (!row.secretRefs) {
    const legacy = splitShareUrl(row.url)
    if ((legacy.fragment || row.ownerToken) && secretStore.isPersistent?.()) {
      // Durable migration is write-first and idempotent. Until it succeeds the
      // cleartext legacy row remains readable, so interrupted upgrades retry.
      const secretRefs: SharedLinkSecretRefs = {}
      if (legacy.fragment) {
        secretRefs.urlFragment = `${row.id}:url-fragment`
        await secretStore.save(secretRefs.urlFragment, legacy.fragment)
      }
      if (row.ownerToken) {
        secretRefs.ownerToken = `${row.id}:owner-token`
        await secretStore.save(secretRefs.ownerToken, row.ownerToken)
      }
      await getDb().sharedLinks.put({
        ...row,
        url: legacy.baseUrl,
        ownerToken: undefined,
        secretRefs,
      })
    }
    return publicSharedLink(row, row.url, row.ownerToken)
  }

  const [fragment, ownerToken] = await Promise.all([
    row.secretRefs.urlFragment ? secretStore.load(row.secretRefs.urlFragment) : null,
    row.secretRefs.ownerToken ? secretStore.load(row.secretRefs.ownerToken) : null,
  ])
  return publicSharedLink(row, row.url + (fragment ?? ""), ownerToken ?? undefined)
}

function publicSharedLink(row: SharedLinkRow, url: string, ownerToken?: string): SharedLinkRow {
  const { secretRefs: _secretRefs, ...publicRow } = row
  return { ...publicRow, url, ownerToken }
}

async function deleteSharedLinkSecrets(row: SharedLinkRow): Promise<void> {
  await Promise.all(
    [row.secretRefs?.urlFragment, row.secretRefs?.ownerToken]
      .filter((ref): ref is string => Boolean(ref))
      .map((ref) => secretStore.delete(ref))
  )
}
