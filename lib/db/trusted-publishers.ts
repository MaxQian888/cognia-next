// Trusted plugin publisher ledger — Ed25519 public keys the user accepted
// when installing a signed WASM plugin. The install flow consults this
// table before showing the fingerprint-confirmation dialog: a key already
// present means "auto-trust subsequent updates from this author".

import { getDb } from "./schema"

/**
 * Trusted plugin publisher ledger — one row per Ed25519 public key the user
 * accepted during a signed-plugin install. Drives "auto-trust subsequent
 * updates from the same author" semantics across HTTP/Git install paths.
 *
 * Co-located with this CRUD module; `schema.ts` imports + re-exports it, so
 * existing `@/lib/db/schema` import sites keep working. See `CONVENTIONS.md`.
 */
export interface TrustedPublisherRow {
  /** Base64-encoded Ed25519 public key (primary key). */
  publicKey: string
  /** SHA-256 hex digest of the public key, for the install-dialog UI. */
  fingerprint: string
  /** Display name from `manifest.author.name` at first-trust time. */
  authorName?: string
  /** Optional contact email captured from `manifest.author.email`. */
  authorEmail?: string
  /** Optional homepage / repository URL captured at first-trust time. */
  homepage?: string
  /** Epoch ms of first accept. */
  firstTrustedAt: number
  /** Epoch ms of the most-recent install/update by this author. */
  lastSeenAt: number
  /** Counter — number of distinct plugins installed by this author. */
  installCount: number
}

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
