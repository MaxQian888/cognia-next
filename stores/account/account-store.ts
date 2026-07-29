import Dexie from "dexie"
import { create, type UseBoundStore, type StoreApi } from "zustand"

import { LocalAccountRegistry, accountDatabaseName } from "@/lib/accounts/account-db"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import {
  legacyDatabaseExists,
  migrateLegacyDatabaseToAccount,
} from "@/lib/accounts/legacy-migration"
import { createPasswordVerifier, verifyPassword } from "@/lib/accounts/password-client"
import { isDevAutoUnlockEnabled } from "@/lib/accounts/dev-auto-unlock"
import { activateAccountDatabase, clearAccountDatabaseSelection } from "@/lib/db/schema"
import {
  activateArtifactAccountStorage,
  clearArtifactAccountStorage,
  purgeArtifactAccountStorage,
} from "@/stores/artifact/artifact-store"
import {
  activateAgentTeamAccountStorage,
  clearAgentTeamAccountStorage,
  purgeAgentTeamAccountStorage,
} from "@/stores/agent/agent-team-store/store"
import {
  activateProjectEditorAccountStorage,
  clearProjectEditorAccountStorage,
  purgeProjectEditorAccountStorage,
} from "@/stores/editor/project-editor-session-store"

export interface CreateLocalAccountInput {
  id?: string
  displayName: string
  password: string
  activate?: boolean
}

export interface DeleteLocalAccountOptions {
  replacementAccountId?: string
}

export interface AccountStoreState {
  accounts: LocalAccountRecord[]
  activeAccountId: string | null
  unlockedAccountId: string | null
  loaded: boolean
  loading: boolean
  locked: boolean
  error: string | null
  accountRevision: number

  load: () => Promise<void>
  createAccount: (input: CreateLocalAccountInput) => Promise<LocalAccountRecord>
  unlockAccount: (accountId: string, password: string) => Promise<void>
  switchAccount: (accountId: string, password?: string) => Promise<void>
  renameAccount: (accountId: string, displayName: string) => Promise<LocalAccountRecord>
  changePassword: (
    accountId: string,
    currentPassword: string,
    newPassword: string
  ) => Promise<LocalAccountRecord>
  setAccountAvatar: (accountId: string, avatarDataUrl: string | null) => Promise<LocalAccountRecord>
  deleteAccount: (accountId: string, options?: DeleteLocalAccountOptions) => Promise<void>
  lock: () => void
}

export interface AccountStoreDependencies {
  registry: LocalAccountRegistry
  dropAccountDatabase: (accountId: string) => Promise<void>
  purgeAccountLocalState: (accountId: string) => Promise<void>
  activateAccountLocalState: (accountId: string) => Promise<void>
  clearAccountLocalState: () => void
}

export type AccountStore = UseBoundStore<StoreApi<AccountStoreState>>

const DEFAULT_STATE = {
  accounts: [],
  activeAccountId: null,
  unlockedAccountId: null,
  loaded: false,
  loading: false,
  locked: false,
  error: null,
  accountRevision: 0,
}

export function createAccountStore(
  dependencyOverrides: Partial<AccountStoreDependencies> = {}
): AccountStore {
  const dependencies: AccountStoreDependencies = {
    registry: new LocalAccountRegistry(),
    dropAccountDatabase: dropDexieAccountDatabase,
    purgeAccountLocalState: purgeLocalStorageForAccount,
    activateAccountLocalState: activateBrowserAccountLocalState,
    clearAccountLocalState: clearBrowserAccountLocalState,
    ...dependencyOverrides,
  }

  return create<AccountStoreState>((set, get) => {
    const setFailure = (error: unknown): Error => {
      const normalized = toError(error)
      set({ error: normalized.message, loading: false })
      return normalized
    }

    const findAccount = async (accountId: string): Promise<LocalAccountRecord> => {
      const existing = get().accounts.find((account) => account.id === accountId)
      if (existing) return existing
      const accounts = await dependencies.registry.listAccounts()
      const account = accounts.find((candidate) => candidate.id === accountId)
      if (!account) {
        throw new Error(`Local account ${accountId} does not exist.`)
      }
      set((state) => ({
        accounts,
        locked: computeLocked(accounts, state.activeAccountId, state.unlockedAccountId),
      }))
      return account
    }

    const activateUnlockedAccount = async (accountId: string): Promise<void> => {
      await dependencies.registry.setActiveAccountId(accountId)
      activateAccountDatabase(accountId)
      await dependencies.activateAccountLocalState(accountId)
      set((state) => ({
        activeAccountId: accountId,
        unlockedAccountId: accountId,
        locked: false,
        error: null,
        accountRevision: state.accountRevision + 1,
      }))
    }

    return {
      ...DEFAULT_STATE,

      load: async () => {
        // `loaded` means the boot read has SETTLED, not that it succeeded — the
        // gate keys its loading shell off it, so a failure must flip it too or
        // the app hangs on "Loading accounts…" forever. The `!error` term is
        // what keeps that from making a transient registry failure permanent:
        // a settled-but-failed load can still be retried.
        if (get().loading) return
        if (get().loaded && !get().error) return
        set({ loading: true, error: null })
        try {
          const [accounts, registryState] = await Promise.all([
            dependencies.registry.listAccounts(),
            dependencies.registry.getState(),
          ])
          // Dev-only: unlock the active account without a password so
          // `pnpm dev` / `pnpm tauri dev` never stop at the gate. Production
          // builds resolve null here and stay locked until the user unlocks.
          const autoUnlockedAccountId = resolveDevAutoUnlockTarget(
            accounts,
            registryState.activeAccountId
          )
          const activeAccountId = autoUnlockedAccountId ?? registryState.activeAccountId
          if (autoUnlockedAccountId) {
            // The resolver can fall back to an account the registry never
            // marked active; persist that pick so the next boot agrees.
            if (autoUnlockedAccountId !== registryState.activeAccountId) {
              await dependencies.registry.setActiveAccountId(autoUnlockedAccountId)
            }
            activateAccountDatabase(autoUnlockedAccountId)
            await dependencies.activateAccountLocalState(autoUnlockedAccountId)
          }
          set((state) => ({
            accounts,
            activeAccountId,
            unlockedAccountId: autoUnlockedAccountId,
            loaded: true,
            loading: false,
            locked: computeLocked(accounts, activeAccountId, autoUnlockedAccountId),
            error: null,
            accountRevision: autoUnlockedAccountId
              ? state.accountRevision + 1
              : state.accountRevision,
          }))
        } catch (error) {
          set({ loaded: true })
          throw setFailure(error)
        }
      },

      createAccount: async (input) => {
        set({ error: null })
        try {
          const existingAccounts = get().loaded
            ? get().accounts
            : await dependencies.registry.listAccounts()
          const isFirstAccount = existingAccounts.length === 0
          const shouldActivate = input.activate ?? isFirstAccount
          const passwordVerifier = await createPasswordVerifier(input.password)
          const account = await dependencies.registry.createAccount({
            id: input.id,
            displayName: input.displayName,
            passwordVerifier,
            activate: shouldActivate,
          })

          if (isFirstAccount && (await legacyDatabaseExists())) {
            await migrateLegacyDatabaseToAccount({
              registry: dependencies.registry,
              targetAccountId: account.id,
            })
          }

          set((state) => {
            const accounts = upsertAccount(state.accounts, account)
            return {
              accounts,
              loaded: state.loaded,
              activeAccountId: shouldActivate ? account.id : state.activeAccountId,
              unlockedAccountId: shouldActivate ? account.id : state.unlockedAccountId,
              locked: shouldActivate
                ? false
                : computeLocked(accounts, state.activeAccountId, state.unlockedAccountId),
              error: null,
              accountRevision: shouldActivate ? state.accountRevision + 1 : state.accountRevision,
            }
          })

          if (shouldActivate) {
            activateAccountDatabase(account.id)
            await dependencies.activateAccountLocalState(account.id)
          }

          return account
        } catch (error) {
          throw setFailure(error)
        }
      },

      unlockAccount: async (accountId, password) => {
        set({ error: null })
        try {
          assertPasswordProvided(password)
          const account = await findAccount(accountId)
          const ok = await verifyPassword(password, account.passwordVerifier)
          if (!ok) {
            throw new Error("Invalid local account password.")
          }
          await activateUnlockedAccount(account.id)
        } catch (error) {
          throw setFailure(error)
        }
      },

      switchAccount: async (accountId, password) => {
        set({ error: null })
        try {
          if (get().unlockedAccountId === accountId) {
            await activateUnlockedAccount(accountId)
            return
          }
          assertPasswordProvided(password)
          const account = await findAccount(accountId)
          const ok = await verifyPassword(password, account.passwordVerifier)
          if (!ok) {
            throw new Error("Invalid local account password.")
          }
          await activateUnlockedAccount(account.id)
        } catch (error) {
          throw setFailure(error)
        }
      },

      renameAccount: async (accountId, displayName) => {
        set({ error: null })
        try {
          const renamed = await dependencies.registry.renameAccount(accountId, displayName)
          set((state) => {
            const accounts = upsertAccount(state.accounts, renamed)
            return {
              accounts,
              locked: computeLocked(accounts, state.activeAccountId, state.unlockedAccountId),
              error: null,
            }
          })
          return renamed
        } catch (error) {
          throw setFailure(error)
        }
      },

      changePassword: async (accountId, currentPassword, newPassword) => {
        set({ error: null })
        try {
          assertPasswordProvided(currentPassword)
          assertPasswordProvided(newPassword)
          const account = await findAccount(accountId)
          const ok = await verifyPassword(currentPassword, account.passwordVerifier)
          if (!ok) {
            throw new Error("Invalid local account password.")
          }
          const passwordVerifier = await createPasswordVerifier(newPassword)
          const updated = await dependencies.registry.updatePasswordVerifier(
            accountId,
            passwordVerifier
          )
          set((state) => {
            const accounts = upsertAccount(state.accounts, updated)
            return {
              accounts,
              locked: computeLocked(accounts, state.activeAccountId, state.unlockedAccountId),
              error: null,
            }
          })
          return updated
        } catch (error) {
          throw setFailure(error)
        }
      },

      setAccountAvatar: async (accountId, avatarDataUrl) => {
        set({ error: null })
        try {
          const updated = await dependencies.registry.updateAvatar(accountId, avatarDataUrl)
          set((state) => {
            const accounts = upsertAccount(state.accounts, updated)
            return {
              accounts,
              locked: computeLocked(accounts, state.activeAccountId, state.unlockedAccountId),
              error: null,
            }
          })
          return updated
        } catch (error) {
          throw setFailure(error)
        }
      },

      deleteAccount: async (accountId, options = {}) => {
        set({ error: null })
        try {
          const wasActive = get().activeAccountId === accountId
          const replacementAccountId = options.replacementAccountId
          await dependencies.registry.deleteAccount(accountId, { replacementAccountId })
          await dependencies.dropAccountDatabase(accountId)
          await dependencies.purgeAccountLocalState(accountId)

          set((state) => {
            const accounts = state.accounts.filter((account) => account.id !== accountId)
            const activeAccountId = wasActive
              ? (replacementAccountId ?? accounts[0]?.id ?? null)
              : state.activeAccountId
            const unlockedAccountId =
              wasActive || state.unlockedAccountId === accountId ? null : state.unlockedAccountId
            return {
              accounts,
              activeAccountId,
              unlockedAccountId,
              locked: computeLocked(accounts, activeAccountId, unlockedAccountId),
              error: null,
              accountRevision: wasActive ? state.accountRevision + 1 : state.accountRevision,
            }
          })

          if (wasActive) {
            clearAccountDatabaseSelection()
            dependencies.clearAccountLocalState()
          }
        } catch (error) {
          throw setFailure(error)
        }
      },

      lock: () => {
        clearAccountDatabaseSelection()
        dependencies.clearAccountLocalState()
        set((state) => ({
          unlockedAccountId: null,
          locked: computeLocked(state.accounts, state.activeAccountId, null),
          error: null,
        }))
      },
    }
  })
}

export const useAccountStore = createAccountStore()

/**
 * ADR-0059 T-B3 — unlock a local account for a HEADLESS HOST process (the
 * `cognia-agent serve` brain). The headless account has no interactive
 * password flow: the host process owns the whole database file, so unlock
 * is an assertion of host identity, not an authentication.
 *
 * Guarded: refuses unless the `__COGNIA_HEADLESS__` marker is set (the serve
 * boot sets it before any lib code runs). In a real browser/WebView the
 * marker never exists, so this can never bypass the password unlock there.
 * The guard is unit-tested.
 */
export async function unlockAccountForHost(accountId: string): Promise<void> {
  const marker = (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
  if (marker !== true) {
    throw new Error(
      "unlockAccountForHost is reserved for headless host processes (__COGNIA_HEADLESS__ not set)"
    )
  }
  activateAccountDatabase(accountId)
  useAccountStore.setState((state) => ({
    activeAccountId: accountId,
    unlockedAccountId: accountId,
    locked: false,
    error: null,
    accountRevision: state.accountRevision + 1,
  }))
}

export function selectActiveAccount(state: AccountStoreState): LocalAccountRecord | null {
  return state.accounts.find((account) => account.id === state.activeAccountId) ?? null
}

function computeLocked(
  accounts: LocalAccountRecord[],
  activeAccountId: string | null,
  unlockedAccountId: string | null
): boolean {
  if (accounts.length === 0) return false
  if (!activeAccountId) return true
  return activeAccountId !== unlockedAccountId
}

/**
 * Resolve which account (if any) a dev build should unlock at boot without a
 * password. Prefers the registry's active account and falls back to the first
 * registered one when that pointer is missing or dangling, so the gate can
 * never appear in dev while any account exists. Never creates an account: with
 * an empty registry the first-run form still runs, because the chosen id scopes
 * the Dexie database. Returns null in production and whenever
 * `NEXT_PUBLIC_ACCOUNT_GATE=1` forces the real gate.
 */
function resolveDevAutoUnlockTarget(
  accounts: LocalAccountRecord[],
  activeAccountId: string | null
): string | null {
  if (!isDevAutoUnlockEnabled()) return null
  if (activeAccountId && accounts.some((account) => account.id === activeAccountId)) {
    return activeAccountId
  }
  return accounts[0]?.id ?? null
}

function upsertAccount(
  accounts: LocalAccountRecord[],
  account: LocalAccountRecord
): LocalAccountRecord[] {
  const index = accounts.findIndex((candidate) => candidate.id === account.id)
  if (index < 0) return [...accounts, account]
  return accounts.map((candidate) => (candidate.id === account.id ? account : candidate))
}

function assertPasswordProvided(password: string | undefined): asserts password is string {
  if (!password?.trim()) {
    throw new Error("Local account password is required.")
  }
}

async function dropDexieAccountDatabase(accountId: string): Promise<void> {
  await Dexie.delete(accountDatabaseName(accountId))
}

async function purgeLocalStorageForAccount(accountId: string): Promise<void> {
  purgeArtifactAccountStorage(accountId)
  purgeAgentTeamAccountStorage(accountId)
  purgeProjectEditorAccountStorage(accountId)
  if (typeof window === "undefined") return
  const prefixes = [
    `cognia-account-${accountId}:`,
    `cognia-artifacts:${accountId}:`,
    `cognia-agent-teams:${accountId}:`,
    `cognia-project-editor-sessions:${accountId}:`,
  ]
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index)
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
      window.localStorage.removeItem(key)
    }
  }
}

async function activateBrowserAccountLocalState(accountId: string): Promise<void> {
  activateArtifactAccountStorage(accountId)
  activateAgentTeamAccountStorage(accountId)
  activateProjectEditorAccountStorage(accountId)
}

function clearBrowserAccountLocalState(): void {
  clearArtifactAccountStorage()
  clearAgentTeamAccountStorage()
  clearProjectEditorAccountStorage()
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === "string") return new Error(error)
  return new Error("Local account operation failed.")
}
