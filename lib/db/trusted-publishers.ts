// Trusted plugin publisher ledger — Ed25519 public keys the user accepted
// when installing a signed WASM plugin. The install flow consults this
// table before showing the fingerprint-confirmation dialog: a key already
// present means "auto-trust subsequent updates from this author".

import { getDb } from "./schema"
import type { TrustedPublisherRow } from "./schema"

export interface TrustPublisherInput {
  publicKey: string
  fingerprint: string
  authorName?: string
  authorEmail?: string
  homepage?: string
}

/**
 * Insert or update a trusted publisher entry. On first trust, stamps
 * `firstTrustedAt`; on every subsequent call, bumps `lastSeenAt` +
 * `installCount`.
 */
export async function trustPublisher(input: TrustPublisherInput): Promise<TrustedPublisherRow> {
  const db = getDb()
  const now = Date.now()
  return db.transaction("rw", db.trustedPublishers, async () => {
    const existing = await db.trustedPublishers.get(input.publicKey)
    const row: TrustedPublisherRow = existing
      ? {
          ...existing,
          fingerprint: input.fingerprint,
          authorName: input.authorName ?? existing.authorName,
          authorEmail: input.authorEmail ?? existing.authorEmail,
          homepage: input.homepage ?? existing.homepage,
          lastSeenAt: now,
          installCount: existing.installCount + 1,
        }
      : {
          publicKey: input.publicKey,
          fingerprint: input.fingerprint,
          authorName: input.authorName,
          authorEmail: input.authorEmail,
          homepage: input.homepage,
          firstTrustedAt: now,
          lastSeenAt: now,
          installCount: 1,
        }
    await db.trustedPublishers.put(row)
    return row
  })
}

/**
 * Return the trust record for a public key, or undefined when the user has
 * never accepted it.
 */
export async function getTrustedPublisher(
  publicKey: string
): Promise<TrustedPublisherRow | undefined> {
  const db = getDb()
  return db.trustedPublishers.get(publicKey)
}

/**
 * True iff this Ed25519 public key was previously trusted by the user.
 * Cheap predicate intended for "do we need to show the fingerprint
 * confirmation step?" decisions.
 */
export async function isPublisherTrusted(publicKey: string): Promise<boolean> {
  if (!publicKey) return false
  const row = await getTrustedPublisher(publicKey)
  return !!row
}

/**
 * List every trusted publisher, sorted newest-first by `firstTrustedAt`.
 * Used by the "Trusted publishers" settings list.
 */
export async function listTrustedPublishers(): Promise<TrustedPublisherRow[]> {
  const db = getDb()
  return db.trustedPublishers.orderBy("firstTrustedAt").reverse().toArray()
}

/**
 * Remove a publisher from the trust ledger. Subsequent installs of plugins
 * signed by this key will once again prompt the user.
 */
export async function revokePublisher(publicKey: string): Promise<void> {
  const db = getDb()
  await db.trustedPublishers.delete(publicKey)
}
