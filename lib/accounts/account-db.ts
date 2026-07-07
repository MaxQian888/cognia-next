import Dexie, { type Table } from "dexie"

import {
  ACCOUNT_REGISTRY_STATE_ID,
  AccountRegistryError,
  assertAccountId,
  clonePasswordVerifier,
  normalizeAccountDisplayName,
  type AccountRegistryState,
  type LegacyMigrationState,
  type LocalAccountRecord,
  type PasswordVerifierRecord,
} from "./account-types"

export const ACCOUNT_REGISTRY_DB_NAME = "cognia-account-registry"
export const ACCOUNT_DB_PREFIX = "cognia-account-"

export class CogniaAccountRegistryDB extends Dexie {
  accounts!: Table<LocalAccountRecord, string>
  state!: Table<AccountRegistryState, typeof ACCOUNT_REGISTRY_STATE_ID>

  constructor(name = ACCOUNT_REGISTRY_DB_NAME) {
    super(name)

    this.version(1).stores({
      accounts: "&id, displayName, createdAt, updatedAt",
      state: "&id, activeAccountId, updatedAt",
    })
  }
}

export interface CreateAccountInput {
  id?: string
  displayName: string
  passwordVerifier: PasswordVerifierRecord
  activate?: boolean
  now?: number
}

export interface DeleteAccountOptions {
  replacementAccountId?: string
  now?: number
}

export interface MarkLegacyMigrationCompletedInput {
  sourceDbName: string
  targetAccountId: string
  completedAt: number
}

export function accountDatabaseName(accountId: string): string {
  return `${ACCOUNT_DB_PREFIX}${assertAccountId(accountId)}`
}

export class LocalAccountRegistry {
  constructor(private readonly db: CogniaAccountRegistryDB = new CogniaAccountRegistryDB()) {}

  async getState(): Promise<AccountRegistryState> {
    return this.ensureState()
  }

  async listAccounts(): Promise<LocalAccountRecord[]> {
    return this.db.accounts.orderBy("createdAt").toArray()
  }

  async getActiveAccountId(): Promise<string | null> {
    const state = await this.ensureState()
    return state.activeAccountId
  }

  async createAccount(input: CreateAccountInput): Promise<LocalAccountRecord> {
    const now = input.now ?? Date.now()
    const account: LocalAccountRecord = {
      id: assertAccountId(input.id ?? generateAccountId()),
      displayName: normalizeAccountDisplayName(input.displayName),
      passwordVerifier: clonePasswordVerifier(input.passwordVerifier),
      createdAt: now,
      updatedAt: now,
    }

    await this.db.transaction("rw", this.db.accounts, this.db.state, async () => {
      const state = await this.ensureState()
      await this.db.accounts.add(account)
      const shouldActivate = input.activate === true || state.activeAccountId === null
      if (shouldActivate) {
        await this.db.state.put({
          ...state,
          activeAccountId: account.id,
          updatedAt: nextTimestamp(now, state.updatedAt),
        })
      }
    })

    return account
  }

  async renameAccount(
    accountId: string,
    displayName: string,
    now = Date.now()
  ): Promise<LocalAccountRecord> {
    assertAccountId(accountId)
    const normalized = normalizeAccountDisplayName(displayName)
    let updated: LocalAccountRecord | undefined

    await this.db.transaction("rw", this.db.accounts, async () => {
      const account = await this.db.accounts.get(accountId)
      if (!account) throw accountNotFound(accountId)
      updated = {
        ...account,
        displayName: normalized,
        updatedAt: nextTimestamp(now, account.updatedAt),
      }
      await this.db.accounts.put(updated)
    })

    return updated as LocalAccountRecord
  }

  async updatePasswordVerifier(
    accountId: string,
    passwordVerifier: PasswordVerifierRecord,
    now = Date.now()
  ): Promise<LocalAccountRecord> {
    assertAccountId(accountId)
    let updated: LocalAccountRecord | undefined

    await this.db.transaction("rw", this.db.accounts, async () => {
      const account = await this.db.accounts.get(accountId)
      if (!account) throw accountNotFound(accountId)
      updated = {
        ...account,
        passwordVerifier: clonePasswordVerifier(passwordVerifier),
        updatedAt: nextTimestamp(now, account.updatedAt),
      }
      await this.db.accounts.put(updated)
    })

    return updated as LocalAccountRecord
  }

  async updateAvatar(
    accountId: string,
    avatarDataUrl: string | null,
    now = Date.now()
  ): Promise<LocalAccountRecord> {
    assertAccountId(accountId)
    let updated: LocalAccountRecord | undefined

    await this.db.transaction("rw", this.db.accounts, async () => {
      const account = await this.db.accounts.get(accountId)
      if (!account) throw accountNotFound(accountId)
      const next: LocalAccountRecord = {
        ...account,
        updatedAt: nextTimestamp(now, account.updatedAt),
      }
      // Empty/whitespace/null clears the avatar back to the glyph fallback.
      if (avatarDataUrl && avatarDataUrl.trim()) {
        next.avatarDataUrl = avatarDataUrl
      } else {
        delete next.avatarDataUrl
      }
      updated = next
      await this.db.accounts.put(updated)
    })

    return updated as LocalAccountRecord
  }

  async setActiveAccountId(accountId: string, now = Date.now()): Promise<void> {
    assertAccountId(accountId)
    await this.db.transaction("rw", this.db.accounts, this.db.state, async () => {
      const account = await this.db.accounts.get(accountId)
      if (!account) throw accountNotFound(accountId)
      const state = await this.ensureState()
      await this.db.state.put({
        ...state,
        activeAccountId: accountId,
        updatedAt: nextTimestamp(now, state.updatedAt),
      })
    })
  }

  async deleteAccount(accountId: string, options: DeleteAccountOptions = {}): Promise<void> {
    assertAccountId(accountId)
    const now = options.now ?? Date.now()

    await this.db.transaction("rw", this.db.accounts, this.db.state, async () => {
      const account = await this.db.accounts.get(accountId)
      if (!account) throw accountNotFound(accountId)

      const count = await this.db.accounts.count()
      if (count <= 1) {
        throw new AccountRegistryError("last-account", "Cannot delete the last account.")
      }

      const state = await this.ensureState()
      let nextActiveAccountId = state.activeAccountId
      if (state.activeAccountId === accountId) {
        if (!options.replacementAccountId || options.replacementAccountId === accountId) {
          throw new AccountRegistryError(
            "replacement-required",
            "Deleting the active account requires a different replacement account."
          )
        }
        assertAccountId(options.replacementAccountId)
        const replacement = await this.db.accounts.get(options.replacementAccountId)
        if (!replacement) throw accountNotFound(options.replacementAccountId)
        nextActiveAccountId = replacement.id
      }

      await this.db.accounts.delete(accountId)
      if (nextActiveAccountId !== state.activeAccountId) {
        await this.db.state.put({
          ...state,
          activeAccountId: nextActiveAccountId,
          updatedAt: nextTimestamp(now, state.updatedAt),
        })
      }
    })
  }

  async markLegacyMigrationCompleted(input: MarkLegacyMigrationCompletedInput): Promise<void> {
    assertAccountId(input.targetAccountId)
    await this.db.transaction("rw", this.db.accounts, this.db.state, async () => {
      const account = await this.db.accounts.get(input.targetAccountId)
      if (!account) throw accountNotFound(input.targetAccountId)
      const state = await this.ensureState()
      const legacyMigration: LegacyMigrationState = {
        status: "completed",
        sourceDbName: input.sourceDbName,
        targetAccountId: input.targetAccountId,
        completedAt: input.completedAt,
      }
      await this.db.state.put({
        ...state,
        legacyMigration,
        updatedAt: nextTimestamp(input.completedAt, state.updatedAt),
      })
    })
  }

  private async ensureState(): Promise<AccountRegistryState> {
    const existing = await this.db.state.get(ACCOUNT_REGISTRY_STATE_ID)
    if (existing) return existing
    const state: AccountRegistryState = {
      id: ACCOUNT_REGISTRY_STATE_ID,
      activeAccountId: null,
      updatedAt: 0,
    }
    await this.db.state.put(state)
    return state
  }
}

function accountNotFound(accountId: string): AccountRegistryError {
  return new AccountRegistryError("account-not-found", `Local account ${accountId} does not exist.`)
}

function nextTimestamp(candidate: number, previous: number): number {
  return candidate > previous ? candidate : previous + 1
}

function generateAccountId(): string {
  const cryptoObject = globalThis.crypto
  if (typeof cryptoObject?.randomUUID === "function") {
    return `acct_${cryptoObject.randomUUID().replace(/-/g, "").slice(0, 24)}`
  }
  return `acct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}
