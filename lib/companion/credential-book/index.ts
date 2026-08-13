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
export async function refileCursorNamespace(from: string, to: string): Promise<void> {
  if (from === to) return
  try {
    const { getDb } = await import("@/lib/db/schema")
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
      activeHostId: () => getActiveRuntimeTargetContext()?.targetId,
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
    await this.markMigrationDone()
    await this.delegate.save(config)
    await this.opts.legacy.clear().catch(() => undefined)
  }

  async clear(): Promise<void> {
    await this.markMigrationDone()
    await this.delegate.clear()
    await this.opts.legacy.clear().catch(() => undefined)
  }

  async remove(config: CompanionConfig): Promise<void> {
    await this.markMigrationDone()
    await this.delegate.remove(config)
  }

  private ensureMigrated(): Promise<void> {
    if (!this.migration) {
      this.migration = (async () => {
        const outcome = await migrateLegacyCompanionConfig({
          book: this.book,
          readLegacy: () => this.opts.legacy.load(),
          clearLegacy: () => this.opts.legacy.clear(),
          refileCursors: this.opts.refileCursors ?? refileCursorNamespace,
          fallbackAccountNamespace:
            this.opts.accountNamespace?.() ?? activeAccountNamespace() ?? DEFAULT_ACCOUNT_NAMESPACE,
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

  private async markMigrationDone(): Promise<void> {
    if (!this.migration) this.migration = Promise.resolve()
    await this.migration
  }
}

/** Test-only: drop the memoised singleton. */
export function __resetCredentialBookForTests(next: CompanionCredentialBook | null = null): void {
  bookInstance = next
}
