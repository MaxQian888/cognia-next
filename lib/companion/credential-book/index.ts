"use client"

/**
 * Composition root for the credential book (ADR-0097).
 *
 * Picks the platform's stores once, exposes the singleton, and wraps it in the
 * one-shot legacy migration so the first read of a not-yet-migrated install
 * moves the old single-config record into the book before answering.
 *
 * The migration is attached here rather than to a boot provider on purpose:
 * `companionStorage().load()` is reached from the transport, the connectivity
 * strategy and the sync orchestrator, and any of them can be the first caller
 * after an upgrade. Gating on a provider that may not have mounted yet would
 * hand one of them a `null` pairing and log the device out.
 */
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { isCapacitor } from "@/lib/platform/detect"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { CompanionConfig, CompanionConfigStorage } from "@/lib/tauri/companion-storage"

import { CredentialBookCompanionStorage } from "./adapter"
import { createCredentialBook } from "./book"
import { migrateLegacyCompanionConfig, type LegacyMigrationOutcome } from "./legacy-migration"
import {
  LocalStorageHostRecordStore,
  SecureStorageHostCredentialStore,
  SecureStorageHostRecordStore,
  VaultHostCredentialStore,
  type HostCredentialStore,
  type HostRecordStore,
} from "./stores"
import { DEFAULT_ACCOUNT_NAMESPACE, type CompanionCredentialBook } from "./types"

export * from "./types"
export { createCredentialBook } from "./book"
export {
  CredentialBookCompanionStorage,
  companionHostCredentialFromConfig,
  companionHostDraftFromConfig,
  toCompanionConfig,
} from "./adapter"
export {
  migrateLegacyCompanionConfig,
  legacyHostId,
  legacyLabel,
  type LegacyMigrationOutcome,
} from "./legacy-migration"
export * from "./stores"

/**
 * The account a pairing belongs to, resolved from whichever runtime scope is
 * live.
 *
 * The runtime-target context is authoritative when set (it is what the account
 * switch writes); the unlocked Vault is the browser fallback before a target has
 * been activated. `null` means "no account is active yet" — the adapter then
 * reports no pairing rather than guessing one.
 */
export function activeAccountNamespace(): string | null {
  return getActiveRuntimeTargetContext()?.accountId ?? getActiveBrowserVault()?.accountId ?? null
}

function pickRecordStore(): HostRecordStore {
  return isCapacitor() ? new SecureStorageHostRecordStore() : new LocalStorageHostRecordStore()
}

function pickCredentialStore(): HostCredentialStore {
  return isCapacitor() ? new SecureStorageHostCredentialStore() : new VaultHostCredentialStore()
}

let bookInstance: CompanionCredentialBook | null = null

export function companionCredentialBook(): CompanionCredentialBook {
  if (!bookInstance) {
    bookInstance = createCredentialBook({
      records: pickRecordStore(),
      credentials: pickCredentialStore(),
    })
  }
  return bookInstance
}

/**
 * Move persisted sync cursors from a legacy `serverKey` onto a host namespace.
 *
 * Best-effort by design: an install with no Dexie (SSR, a locked database) has
 * no cursors to lose, and a failure here only costs one full re-pull.
 *
 * A row already under `to` wins. The sync orchestrator adopts these same legacy
 * keys itself (`companion-sync.ts:adoptLegacyCursorKeys`) because a sync tick
 * can beat this migration, so both paths have to agree on which watermark
 * survives — otherwise whichever ran second would rewind the other's.
 */
export async function refileCursorNamespace(
  from: string,
  to: string,
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (from === to) return
  try {
    const { getDb } = await import("@/lib/db/schema")
    if (!isCurrent()) return
    const db = getDb()
    const rows = await db.hostSyncCursors.where("serverKey").equals(from).toArray()
    if (rows.length === 0) return
    const claimed = new Set(
      (await db.hostSyncCursors.where("serverKey").equals(to).toArray()).map((row) => row.table)
    )
    const moved = rows
      .filter((row) => !claimed.has(row.table))
      .map((row) => ({ ...row, serverKey: to }))
    if (moved.length > 0) await db.hostSyncCursors.bulkPut(moved)
    await db.hostSyncCursors.where("serverKey").equals(from).delete()
  } catch {
    // See jsdoc — a lost watermark costs a re-pull, never data.
  }
}

export interface MigratingStorageOptions {
  book?: CompanionCredentialBook
  /** The pre-book storage the migration reads from and then clears. */
  legacy: CompanionConfigStorage
  accountNamespace?: () => string | null
  refileCursors?: (from: string, to: string) => Promise<void>
  /** Reported so callers/tests can assert the outcome without re-running it. */
  onMigrated?: (outcome: LegacyMigrationOutcome) => void
}

/**
 * `CompanionConfigStorage` that migrates once, then delegates to the book.
 *
 * The migration promise is memoised, so the several modules that race to read
 * the pairing at boot all await the same single run.
 */
export class MigratingCompanionStorage implements CompanionConfigStorage {
  private readonly book: CompanionCredentialBook
  private readonly delegate: CredentialBookCompanionStorage
  private migration: Promise<void> | null = null

  constructor(private readonly opts: MigratingStorageOptions) {
    this.book = opts.book ?? companionCredentialBook()
    this.delegate = new CredentialBookCompanionStorage({
      book: this.book,
      accountNamespace: opts.accountNamespace ?? activeAccountNamespace,
      activeHostId: () => {
        const targetId = getActiveRuntimeTargetContext()?.targetId
        // Native legacy boot knows the owner before it knows the migrated Host.
        // Only that opening placeholder may resolve through the account's pointer.
        return isCapacitor() && targetId === "mobile-companion" ? undefined : targetId
      },
    })
  }

  async load(): Promise<CompanionConfig | null> {
    await this.ensureMigrated()
    return this.delegate.load()
  }

  async save(config: CompanionConfig): Promise<void> {
    // No migration first: a `save` is a *newer* pairing than anything the
    // legacy record holds, and running the migration afterwards would let the
    // stale legacy record win the `upsert` race.
    const namespace = this.opts.accountNamespace?.() ?? activeAccountNamespace()
    await this.markMigrationDone()
    this.assertCurrentNamespace(namespace)
    await this.delegate.save(config)
    await this.clearOwnedLegacy(namespace)
  }

  async updateMetadata(config: CompanionConfig, isCurrent: () => boolean): Promise<boolean> {
    await this.ensureMigrated()
    return this.delegate.updateMetadata(config, isCurrent)
  }

  async clear(): Promise<void> {
    const namespace = this.opts.accountNamespace?.() ?? activeAccountNamespace()
    await this.markMigrationDone()
    this.assertCurrentNamespace(namespace)
    await this.delegate.clear()
    await this.clearOwnedLegacy(namespace)
  }

  async remove(config: CompanionConfig): Promise<void> {
    const namespace = this.opts.accountNamespace?.() ?? activeAccountNamespace()
    await this.markMigrationDone()
    this.assertCurrentNamespace(namespace)
    await this.delegate.remove(config)
  }

  private ensureMigrated(): Promise<void> {
    if (!this.migration) {
      this.migration = (async () => {
        const namespace = this.opts.accountNamespace?.() ?? activeAccountNamespace()
        const legacy = await this.opts.legacy.load()
        if (
          isCapacitor() &&
          legacy &&
          ((legacy.accountId ?? DEFAULT_LOCAL_ACCOUNT_ID) !== namespace ||
            namespace !== (this.opts.accountNamespace?.() ?? activeAccountNamespace()))
        ) {
          // SecureStorage predates profiles. Defer, retaining its only copy,
          // until the historical owner is active; another profile cannot adopt it.
          this.migration = null
          return
        }
        const outcome = await migrateLegacyCompanionConfig({
          book: this.book,
          readLegacy: async () => legacy,
          clearLegacy: () => this.opts.legacy.clear(),
          refileCursors: async (from, to) => {
            if (
              isCapacitor() &&
              namespace !== (this.opts.accountNamespace?.() ?? activeAccountNamespace())
            )
              return
            if (this.opts.refileCursors) await this.opts.refileCursors(from, to)
            else
              await refileCursorNamespace(
                from,
                to,
                () =>
                  !isCapacitor() ||
                  namespace === (this.opts.accountNamespace?.() ?? activeAccountNamespace())
              )
          },
          fallbackAccountNamespace: isCapacitor()
            ? DEFAULT_LOCAL_ACCOUNT_ID
            : (namespace ?? DEFAULT_ACCOUNT_NAMESPACE),
        })
        this.opts.onMigrated?.(outcome)
      })().catch(() => {
        // A failed migration must not wedge the pairing: the legacy record is
        // still intact, and the next `load()` re-attempts because the memo is
        // cleared here.
        this.migration = null
      })
    }
    return this.migration
  }

  private assertCurrentNamespace(namespace: string | null): void {
    if (
      isCapacitor() &&
      namespace !== (this.opts.accountNamespace?.() ?? activeAccountNamespace())
    ) {
      throw new Error("Companion account changed during storage mutation.")
    }
  }

  private async clearOwnedLegacy(operationNamespace: string | null): Promise<void> {
    try {
      if (isCapacitor()) {
        const legacy = await this.opts.legacy.load()
        const namespace = this.opts.accountNamespace?.() ?? activeAccountNamespace()
        if (
          namespace !== operationNamespace ||
          (legacy && (legacy.accountId ?? DEFAULT_LOCAL_ACCOUNT_ID) !== operationNamespace)
        ) {
          this.migration = null
          return
        }
      }
      await this.opts.legacy.clear()
    } catch {
      // Retain the source if SecureStorage is temporarily unavailable.
      this.migration = null
    }
  }

  private async markMigrationDone(): Promise<void> {
    if (!this.migration) this.migration = Promise.resolve()
    await this.migration
  }
}

/** Test-only: drop the memoised singleton. */
export function __resetCredentialBookForTests(next: CompanionCredentialBook | null = null): void {
  bookInstance = next
}
