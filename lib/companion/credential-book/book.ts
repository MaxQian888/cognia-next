"use client"

/**
 * The credential book itself — {@link CompanionCredentialBook} over a public
 * {@link HostRecordStore} and a secret {@link HostCredentialStore}.
 *
 * Two invariants the implementation exists to hold:
 *
 * 1. **`cursorNamespace` is assigned once and never moves.** It is what sync
 *    cursors, outbound-queue rows and the runtime-target database are filed
 *    under; a namespace that changed on a re-pair or a label edit would orphan
 *    all three. `upsert` therefore preserves the stored namespace and only
 *    derives a fresh one for a genuinely new record.
 * 2. **`remove` drops the secret before the record.** The record is the only
 *    thing that can address the credential, so the reverse order would leave an
 *    unreachable device JWT sitting in the keystore forever.
 */
import {
  deriveCursorNamespace,
  hostRecordKey,
  initialConnectionState,
  StaleConnectionGenerationError,
  type CompanionConnectionPatch,
  type CompanionCredentialBook,
  type CompanionHostCredential,
  type CompanionHostDraft,
  type CompanionHostKey,
  type CompanionHostRecord,
} from "./types"
import type { HostCredentialStore, HostRecordStore } from "./stores"

export interface CredentialBookOptions {
  records: HostRecordStore
  credentials: HostCredentialStore
  /** Injected clock (tests). */
  now?: () => number
}

export function createCredentialBook(opts: CredentialBookOptions): CompanionCredentialBook {
  const now = opts.now ?? Date.now
  // Every mutation runs on this tail so two concurrent callers cannot
  // read-modify-write the same envelope and lose one of the writes. The book is
  // small and mutations are rare, so a single lane costs nothing.
  let tail: Promise<unknown> = Promise.resolve()

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(fn, fn)
    tail = next.catch(() => undefined)
    return next
  }

  async function list(accountNamespace?: string): Promise<CompanionHostRecord[]> {
    const book = await opts.records.read()
    const all = Object.values(book.hosts)
    const scoped = accountNamespace
      ? all.filter((record) => record.accountNamespace === accountNamespace)
      : all
    return scoped.sort((a, b) => a.label.localeCompare(b.label) || a.hostId.localeCompare(b.hostId))
  }

  async function get(key: CompanionHostKey): Promise<CompanionHostRecord | null> {
    const book = await opts.records.read()
    return book.hosts[hostRecordKey(key)] ?? null
  }

  async function upsert(draft: CompanionHostDraft): Promise<CompanionHostRecord> {
    return serialize(async () => {
      const key: CompanionHostKey = {
        hostId: draft.hostId,
        accountNamespace: draft.accountNamespace,
      }
      const storageKey = hostRecordKey(key)
      const book = await opts.records.read()
      const existing = book.hosts[storageKey]
      const record: CompanionHostRecord = {
        ...draft,
        // Preserve the assigned namespace — see invariant 1.
        cursorNamespace: existing?.cursorNamespace ?? deriveCursorNamespace(key),
        connection: draft.connection ?? existing?.connection ?? initialConnectionState(),
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
      }
      book.hosts[storageKey] = record
      // First pairing for an account becomes its active host: a client that
      // just paired and has no active pointer would otherwise look unpaired.
      if (!book.active[draft.accountNamespace]) {
        book.active[draft.accountNamespace] = storageKey
      }
      await opts.records.write(book)
      return record
    })
  }

  async function remove(key: CompanionHostKey): Promise<void> {
    return serialize(async () => {
      const storageKey = hostRecordKey(key)
      const book = await opts.records.read()
      if (!book.hosts[storageKey]) return
      await opts.credentials.remove(key)
      delete book.hosts[storageKey]
      if (book.active[key.accountNamespace] === storageKey) {
        // Promote whatever else this account has, so removing the active host
        // does not silently strand the account with no reachable pairing.
        const fallback = Object.entries(book.hosts).find(
          ([, record]) => record.accountNamespace === key.accountNamespace
        )
        if (fallback) book.active[key.accountNamespace] = fallback[0]
        else delete book.active[key.accountNamespace]
      }
      await opts.records.write(book)
    })
  }

  async function getActive(accountNamespace: string): Promise<CompanionHostRecord | null> {
    const book = await opts.records.read()
    const storageKey = book.active[accountNamespace]
    if (storageKey) {
      const record = book.hosts[storageKey]
      if (record && record.accountNamespace === accountNamespace) return record
    }
    // No pointer (or a dangling one): a single pairing is unambiguous, more
    // than one is not — the caller must choose rather than get a coin flip.
    const candidates = Object.values(book.hosts).filter(
      (record) => record.accountNamespace === accountNamespace
    )
    return candidates.length === 1 ? candidates[0] : null
  }

  async function setActive(key: CompanionHostKey): Promise<void> {
    return serialize(async () => {
      const storageKey = hostRecordKey(key)
      const book = await opts.records.read()
      if (!book.hosts[storageKey]) {
        throw new Error(`No companion host ${key.hostId} is paired for ${key.accountNamespace}.`)
      }
      book.active[key.accountNamespace] = storageKey
      await opts.records.write(book)
    })
  }

  async function loadCredential(key: CompanionHostKey): Promise<CompanionHostCredential | null> {
    return opts.credentials.load(key)
  }

  async function saveCredential(
    key: CompanionHostKey,
    credential: CompanionHostCredential
  ): Promise<void> {
    await opts.credentials.save(key, credential)
  }

  async function updateConnection(
    key: CompanionHostKey,
    patch: CompanionConnectionPatch,
    expectedGeneration?: number
  ): Promise<CompanionHostRecord> {
    return serialize(async () => {
      const storageKey = hostRecordKey(key)
      const book = await opts.records.read()
      const record = book.hosts[storageKey]
      if (!record) {
        throw new Error(`No companion host ${key.hostId} is paired for ${key.accountNamespace}.`)
      }
      if (expectedGeneration !== undefined && expectedGeneration !== record.connection.generation) {
        throw new StaleConnectionGenerationError(expectedGeneration, record.connection.generation)
      }
      const stamp = now()
      const next: CompanionHostRecord = {
        ...record,
        connection: {
          status: patch.status,
          generation: record.connection.generation + 1,
          lastOkAt:
            patch.lastOkAt !== undefined
              ? patch.lastOkAt
              : patch.status === "online"
                ? stamp
                : record.connection.lastOkAt,
          lastErrorAt:
            patch.lastErrorAt !== undefined
              ? patch.lastErrorAt
              : patch.status === "offline" || patch.status === "revoked"
                ? stamp
                : record.connection.lastErrorAt,
          lastError: patch.lastError !== undefined ? patch.lastError : record.connection.lastError,
        },
        updatedAt: stamp,
      }
      book.hosts[storageKey] = next
      await opts.records.write(book)
      return next
    })
  }

  return {
    list,
    get,
    upsert,
    remove,
    getActive,
    setActive,
    loadCredential,
    saveCredential,
    updateConnection,
  }
}
