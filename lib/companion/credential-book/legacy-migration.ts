"use client"

/**
 * One-time migration of the single-`CompanionConfig` record into the book.
 *
 * Ordering is the whole design. The legacy record is the only copy of the
 * device JWT until the migration completes, so it is dropped **last** and only
 * after a verification read proves the book can produce the same pairing:
 *
 *   1. write the host record (public)
 *   2. write the credential (secret)
 *   3. re-file the persisted sync cursors onto the new namespace
 *   4. read both halves back and compare
 *   5. only then remove the legacy record
 *
 * A crash at any step leaves the legacy record intact and the migration simply
 * re-runs; every step is idempotent. A verification failure leaves it intact
 * too, and reports why — losing the pairing would force a physical re-pair.
 */
import type { CompanionConfig } from "@/lib/tauri/companion-storage"

import {
  DEFAULT_ACCOUNT_NAMESPACE,
  deriveCursorNamespace,
  hostKeyOf,
  type CompanionCredentialBook,
  type CompanionHostKey,
  type CompanionHostRecord,
} from "./types"

/** The pieces of the legacy world the migration needs to touch. */
export interface LegacyMigrationDeps {
  book: CompanionCredentialBook
  /** Read the legacy single-config record. `null` when already migrated. */
  readLegacy: () => Promise<CompanionConfig | null>
  /** Remove the legacy record. Called last, only on success. */
  clearLegacy: () => Promise<void>
  /**
   * Move persisted sync cursors from the legacy `serverKey` onto the record's
   * `cursorNamespace`. Optional: an install with no cursors migrates fine.
   */
  refileCursors?: (from: string, to: string) => Promise<void>
  /** Account namespace to file the pairing under when the record omits one. */
  fallbackAccountNamespace: string
  now?: () => number
}

export type LegacyMigrationOutcome =
  | { kind: "nothing-to-migrate" }
  | { kind: "migrated"; record: CompanionHostRecord }
  | { kind: "failed"; reason: string }

/**
 * Derive a stable host id for a legacy pairing.
 *
 * `targetId` is already the browser build's stable per-host id; `deviceId` is
 * the identity the host issued and is unique per pairing everywhere else. Using
 * `targetId ?? deviceId` means a web install migrates onto the same id its
 * v2 target book already used, so nothing is duplicated.
 */
export function legacyHostId(config: CompanionConfig): string {
  return config.targetId ?? config.deviceId
}

/**
 * The cursor namespace a flat {@link CompanionConfig} files under.
 *
 * Derived rather than read back from the book because the sync orchestrator
 * needs it synchronously, before it may touch Dexie. It cannot drift from the
 * stored value: `hostId` and `accountNamespace` are the record's primary key,
 * so neither can change while the record exists, and `deriveCursorNamespace`
 * is a pure function of the two.
 */
export function companionCursorNamespace(config: CompanionConfig): string {
  return deriveCursorNamespace({
    hostId: legacyHostId(config),
    accountNamespace: config.accountId ?? DEFAULT_ACCOUNT_NAMESPACE,
  })
}

export function legacyLabel(config: CompanionConfig): string {
  try {
    return new URL(config.baseUrl).hostname || config.baseUrl
  } catch {
    return config.baseUrl
  }
}

export async function migrateLegacyCompanionConfig(
  deps: LegacyMigrationDeps
): Promise<LegacyMigrationOutcome> {
  const now = deps.now ?? Date.now
  const legacy = await deps.readLegacy()
  if (!legacy) return { kind: "nothing-to-migrate" }

  const key: CompanionHostKey = {
    hostId: legacyHostId(legacy),
    accountNamespace: legacy.accountId ?? deps.fallbackAccountNamespace,
  }

  try {
    const record = await deps.book.upsert({
      hostId: key.hostId,
      accountNamespace: key.accountNamespace,
      label: legacyLabel(legacy),
      endpoints: {
        baseUrl: legacy.baseUrl,
        lanBaseUrl: legacy.lanBaseUrl,
        tunnelBaseUrl: legacy.tunnelBaseUrl,
      },
      tlsPin: legacy.serverFingerprint ?? null,
      deviceId: legacy.deviceId,
      serverVersion: legacy.serverVersion,
      rendezvousId: legacy.rendezvousId,
      signalingRoomDescriptor: legacy.signalingRoomDescriptor,
    })

    await deps.book.saveCredential(key, {
      deviceJwt: legacy.deviceJwt,
      signalingPrivateKeyJwk: legacy.signalingPrivateKeyJwk,
    })

    // The legacy cursors are filed under the device id; move them onto the
    // record's namespace so the first post-migration sync resumes from the
    // same watermark instead of re-pulling the host's whole history.
    if (deps.refileCursors && legacy.deviceId !== record.cursorNamespace) {
      await deps.refileCursors(legacy.deviceId, record.cursorNamespace)
    }

    const verification = await verifyMigration(deps.book, record, legacy)
    if (verification) return { kind: "failed", reason: verification }

    await deps.clearLegacy()
    void now()
    return { kind: "migrated", record }
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Read both halves back and compare against the source.
 *
 * Returns `null` on success, or the reason the legacy record must be kept.
 * Deliberately compares the fields that would cause a *silent* failure if they
 * were lost — the TLS pin (a dropped pin downgrades to unpinned TLS), the
 * device JWT (a dropped token means an unrecoverable re-pair), and the base URL.
 */
async function verifyMigration(
  book: CompanionCredentialBook,
  record: CompanionHostRecord,
  legacy: CompanionConfig
): Promise<string | null> {
  const stored = await book.get(hostKeyOf(record))
  if (!stored) return "the migrated host record could not be read back"
  if (stored.endpoints.baseUrl !== legacy.baseUrl) {
    return "the migrated host record has a different base URL"
  }
  if (stored.tlsPin !== (legacy.serverFingerprint ?? null)) {
    return "the migrated host record lost its TLS pin"
  }
  if (stored.deviceId !== legacy.deviceId) {
    return "the migrated host record has a different device id"
  }
  const credential = await book.loadCredential(hostKeyOf(record))
  if (!credential) return "the migrated credential could not be read back"
  if (credential.deviceJwt !== legacy.deviceJwt) {
    return "the migrated credential holds a different device token"
  }
  if (
    JSON.stringify(credential.signalingPrivateKeyJwk ?? null) !==
    JSON.stringify(legacy.signalingPrivateKeyJwk ?? null)
  ) {
    return "the migrated credential lost its signaling key"
  }
  return null
}
