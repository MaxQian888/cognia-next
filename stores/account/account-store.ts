import Dexie from "dexie"
import { create, type UseBoundStore, type StoreApi } from "zustand"

import {
  LocalAccountRegistry,
  accountDatabaseName,
  generateAccountId,
} from "@/lib/accounts/account-db"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import {
  legacyDatabaseExists,
  migrateLegacyDatabaseToAccount,
} from "@/lib/accounts/legacy-migration"
import {
  createPasswordVerifier,
  rebindPasswordVerifier,
  unbindLocalAccount,
  verifyPassword,
} from "@/lib/accounts/password-client"
import { isDevAutoUnlockEnabled } from "@/lib/accounts/dev-auto-unlock"
import { AccountUnlockError, asUnlockError } from "@/lib/accounts/account-unlock-error"
import { publishUnlockStage } from "@/lib/accounts/unlock-progress"
import { isCapacitor, isTauri } from "@/lib/platform/detect"
import {
  changeBrowserVaultPassword,
  deleteBrowserVault,
  lockBrowserVault,
  provisionBrowserVault,
  resetBrowserVaultPasswordWithRecoveryKey,
  unlockBrowserVault,
  verifyBrowserVaultPassword,
} from "@/lib/runtime/browser-vault"
import {
  prepareAccountRuntimeTarget,
  removeAccountRuntimeTargets,
} from "@/lib/runtime/account-runtime-target"
import type { RuntimeTargetRecord } from "@/lib/runtime/target-registry"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { stopRuntimeTargetSubscriptions } from "@/lib/runtime/runtime-target-lifecycle"
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
import { bumpPerformanceSecurityGeneration } from "@/lib/perf/security-generation"

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
  pendingRecoveryKey: string | null
  accountRevision: number

  load: () => Promise<void>
  createAccount: (input: CreateLocalAccountInput) => Promise<LocalAccountRecord>
  unlockAccount: (accountId: string, password: string) => Promise<void>
  /**
   * Redeem the Browser Vault recovery key and rotate the password in one step.
   * Browser runtimes only — the desktop host mints no recovery key, so there is
   * nothing to redeem there and the call refuses rather than pretending.
   */
  unlockAccountWithRecoveryKey: (
    accountId: string,
    recoveryKey: string,
    newPassword: string
  ) => Promise<void>
  switchAccount: (accountId: string, password?: string) => Promise<void>
  renameAccount: (accountId: string, displayName: string) => Promise<LocalAccountRecord>
  changePassword: (
    accountId: string,
    currentPassword: string,
    newPassword: string
  ) => Promise<LocalAccountRecord>
  setAccountAvatar: (accountId: string, avatarDataUrl: string | null) => Promise<LocalAccountRecord>
  deleteAccount: (
    accountId: string,
    options?: DeleteLocalAccountOptions
  ) => Promise<LocalAccountDeletionResult>
  lock: () => Promise<void>
  acknowledgeRecoveryKey: () => void
}

export interface AccountStoreDependencies {
  registry: LocalAccountRegistry
  dropAccountDatabase: (accountId: string) => Promise<void>
  purgeAccountLocalState: (accountId: string) => Promise<void>
  activateAccountLocalState: (accountId: string) => Promise<void>
  clearAccountLocalState: () => void
  prepareRuntimeTarget: (accountId: string) => Promise<RuntimeTargetRecord>
  prepareDatabase: () => Promise<unknown>
  removeRuntimeTargets: (accountId: string) => Promise<unknown>
  clearSubscriptionRuntime: (localAccountId: string) => Promise<void>
  /**
   * Release the live per-target subscriptions before the database closes.
   * Wired only into the target-switch path before ADR-0009's lock path was
   * audited; a lock that skips it leaves module-level subscribers running
   * against a database selection that no longer exists.
   */
  stopRuntimeSubscriptions: () => Promise<void>
}

export interface LocalAccountDeletionResult {
  accountId: string
  wasActive: boolean
  registryDeleted: true
  accountDatabaseDeleted: true
  runtimeTargetsDeleted: boolean
  localStatePurged: true
  browserVaultDeleted: boolean
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
  pendingRecoveryKey: null,
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
    prepareRuntimeTarget: prepareAccountRuntimeTarget,
    prepareDatabase: async () => {
      const { ensureActiveDatabaseReady } = await import("@/lib/db/boot")
      return ensureActiveDatabaseReady()
    },
    removeRuntimeTargets: removeAccountRuntimeTargets,
    stopRuntimeSubscriptions: stopRuntimeTargetSubscriptions,
    clearSubscriptionRuntime: async (localAccountId) => {
      if (!isTauri() && !isCapacitor()) {
        const { hasWebCompanionTarget } = await import("@/lib/platform/web-companion")
        if (!hasWebCompanionTarget()) return
      }
      const { clearSubscriptionRuntime } = await import("@/lib/subscription/core/transport")
      await clearSubscriptionRuntime(localAccountId)
    },
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

    const prepareSelectedDatabase = async (accountId: string, targetId?: string) => {
      activateSelectedDatabase(accountId, targetId)
      await dependencies.prepareDatabase()
    }

    const activateUnlockedAccount = async (accountId: string): Promise<void> => {
      const previousUnlockedAccountId = get().unlockedAccountId
      if (previousUnlockedAccountId && previousUnlockedAccountId !== accountId) {
        await dependencies.clearSubscriptionRuntime(previousUnlockedAccountId)
      }
      await dependencies.registry.setActiveAccountId(accountId)
      let target: RuntimeTargetRecord | null = null
      if (shouldUseBrowserVault()) {
        publishUnlockStage(accountId, "preparing-runtime")
        target = await dependencies.prepareRuntimeTarget(accountId)
      }
      // The long pole. `lock()` closed the cached Dexie connection, so this
      // re-opens the schema, re-adopts plugin tables and re-seeds — seconds of
      // work that the lock screen has to be able to name.
      publishUnlockStage(accountId, "opening-database")
      await prepareSelectedDatabase(accountId, target?.id)
      publishUnlockStage(accountId, "activating")
      setActiveRuntimeTargetContext(
        accountId,
        target?.id ?? (isCapacitor() ? "mobile-companion" : "local-host")
      )
      await dependencies.activateAccountLocalState(accountId)
      set((state) => ({
        activeAccountId: accountId,
        unlockedAccountId: accountId,
        locked: false,
        error: null,
        accountRevision: state.accountRevision + 1,
      }))
      publishUnlockStage(accountId, "ready")
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
            const target = shouldUseBrowserVault()
              ? await dependencies.prepareRuntimeTarget(autoUnlockedAccountId)
              : null
            await prepareSelectedDatabase(autoUnlockedAccountId, target?.id)
            setActiveRuntimeTargetContext(
              autoUnlockedAccountId,
              target?.id ?? (isCapacitor() ? "mobile-companion" : "local-host")
            )
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
          const accountId = input.id ?? generateAccountId()
          const passwordVerifier = await createPasswordVerifier(input.password)
          const useBrowserVault = shouldUseBrowserVault()
          const recoveryKey = useBrowserVault
            ? await provisionBrowserVault(accountId, input.password)
            : null
          let account: LocalAccountRecord
          try {
            account = await dependencies.registry.createAccount({
              id: accountId,
              displayName: input.displayName,
              passwordVerifier,
              activate: shouldActivate,
            })
          } catch (error) {
            if (useBrowserVault) {
              await deleteBrowserVault(accountId).catch(() => {})
            }
            throw error
          }

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
              pendingRecoveryKey: recoveryKey,
              accountRevision: shouldActivate ? state.accountRevision + 1 : state.accountRevision,
            }
          })

          if (shouldActivate) {
            const target = useBrowserVault
              ? await dependencies.prepareRuntimeTarget(account.id)
              : null
            await prepareSelectedDatabase(account.id, target?.id)
            setActiveRuntimeTargetContext(
              account.id,
              target?.id ?? (isCapacitor() ? "mobile-companion" : "local-host")
            )
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
          publishUnlockStage(account.id, "verifying")
          if (shouldUseBrowserVault()) {
            await unlockBrowserVault(account.id, password)
          } else {
            const ok = await verifyPassword(password, account.passwordVerifier, account.id)
            if (!ok) {
              throw new AccountUnlockError("invalid-password", "Invalid local account password.")
            }
          }
          await activateUnlockedAccount(account.id)
        } catch (error) {
          publishUnlockStage(accountId, "failed")
          throw setFailure(asUnlockError(error))
        }
      },

      unlockAccountWithRecoveryKey: async (accountId, recoveryKey, newPassword) => {
        set({ error: null })
        try {
          if (!shouldUseBrowserVault()) {
            // Not dormancy: the desktop host stores no recovery wrap at all, so
            // there is no key to redeem. The lock screen hides the entry point
            // on this runtime; this is the backstop for a programmatic caller.
            throw new AccountUnlockError(
              "vault-not-provisioned",
              "Recovery keys exist only for the Browser Vault runtime."
            )
          }
          if (!recoveryKey.trim()) {
            throw new AccountUnlockError("invalid-recovery-key", "Vault recovery key is required.")
          }
          assertPasswordProvided(newPassword)
          const account = await findAccount(accountId)
          publishUnlockStage(account.id, "verifying")
          // Rotating the password is part of redeeming the key, not a follow-up
          // step: unlocking alone leaves `passwordWrap` keyed to the password
          // the user just proved they no longer have.
          await resetBrowserVaultPasswordWithRecoveryKey(
            account.id,
            recoveryKey.trim(),
            newPassword
          )
          const passwordVerifier = await createPasswordVerifier(newPassword)
          const updated = await dependencies.registry.updatePasswordVerifier(
            account.id,
            passwordVerifier
          )
          set((state) => ({ accounts: upsertAccount(state.accounts, updated) }))
          await activateUnlockedAccount(account.id)
        } catch (error) {
          publishUnlockStage(accountId, "failed")
          throw setFailure(asUnlockError(error))
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
          publishUnlockStage(account.id, "verifying")
          if (shouldUseBrowserVault()) {
            await unlockBrowserVault(account.id, password)
          } else {
            const ok = await verifyPassword(password, account.passwordVerifier, account.id)
            if (!ok) {
              throw new AccountUnlockError("invalid-password", "Invalid local account password.")
            }
          }
          await activateUnlockedAccount(account.id)
        } catch (error) {
          publishUnlockStage(accountId, "failed")
          throw setFailure(asUnlockError(error))
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
          const useBrowserVault = shouldUseBrowserVault()
          const ok = useBrowserVault
            ? await verifyBrowserVaultPassword(accountId, currentPassword)
            : await verifyPassword(currentPassword, account.passwordVerifier, account.id)
          if (!ok) {
            throw new AccountUnlockError("invalid-password", "Invalid local account password.")
          }
          const passwordVerifier = await createPasswordVerifier(newPassword)
          const updated = await dependencies.registry.updatePasswordVerifier(
            accountId,
            passwordVerifier
          )
          if (useBrowserVault) {
            try {
              await changeBrowserVaultPassword(accountId, currentPassword, newPassword)
            } catch (vaultError) {
              try {
                await dependencies.registry.updatePasswordVerifier(
                  accountId,
                  account.passwordVerifier
                )
              } catch (rollbackError) {
                throw new AggregateError(
                  [vaultError, rollbackError],
                  "Browser Vault password update failed and the registry verifier could not be rolled back."
                )
              }
              throw vaultError
            }
          }
          // The host pins its account binding to the verifier it first saw, so a
          // rotation has to re-pin or every later unlock is refused as a
          // mismatch. Runs after the registry write so a failed rotation cannot
          // leave the host trusting a verifier the account no longer has.
          if (!useBrowserVault) {
            await rebindPasswordVerifier(accountId, passwordVerifier)
          }
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
          if (wasActive && get().unlockedAccountId === accountId) {
            await dependencies.clearSubscriptionRuntime(accountId)
          }
          await dependencies.registry.deleteAccount(accountId, { replacementAccountId })
          await dependencies.dropAccountDatabase(accountId)
          let runtimeTargetsDeleted = false
          if (shouldUseBrowserVault()) {
            await dependencies.removeRuntimeTargets(accountId)
            runtimeTargetsDeleted = true
          }
          await dependencies.purgeAccountLocalState(accountId)
          let browserVaultDeleted = false
          if (shouldUseBrowserVault()) {
            await deleteBrowserVault(accountId)
            browserVaultDeleted = true
          }

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
            clearActiveRuntimeTargetContext()
            clearAccountDatabaseSelection()
            dependencies.clearAccountLocalState()
          }
          return {
            accountId,
            wasActive,
            registryDeleted: true,
            accountDatabaseDeleted: true,
            runtimeTargetsDeleted,
            localStatePurged: true,
            browserVaultDeleted,
          }
        } catch (error) {
          throw setFailure(error)
        }
      },

      /**
       * Lock the active account.
       *
       * Two properties this deliberately guarantees, both of which the earlier
       * version did not:
       *
       * 1. **Subscriptions stop before the database does.** `lock()` clears the
       *    database selection, and `getDb()` falls back to the LEGACY database
       *    name when no account is selected — so any live subscriber that
       *    outlived the gate's unmount and called `getDb()` afterwards silently
       *    re-opened `cognia-claude` and kept reading and writing there. Killing
       *    the subscriptions first is what makes the lock actually cut access.
       *
       * 2. **It cannot fail open.** Every teardown step is best-effort and the
       *    locked state is committed unconditionally. Previously a throw in any
       *    step returned before `set(...)`, so the vault could be locked while
       *    the UI still believed the account was unlocked — the one outcome a
       *    lock must never produce. A failed step is still reported.
       */
      lock: async () => {
        const unlockedAccountId = get().unlockedAccountId
        if (unlockedAccountId) {
          bumpPerformanceSecurityGeneration(unlockedAccountId, "account-locked")
        }
        const failures: unknown[] = []
        const attempt = async (step: () => void | Promise<void>) => {
          try {
            await step()
          } catch (error) {
            failures.push(error)
          }
        }

        await attempt(() => dependencies.stopRuntimeSubscriptions())
        if (unlockedAccountId) {
          await attempt(() => dependencies.clearSubscriptionRuntime(unlockedAccountId))
        }
        await attempt(() => unbindLocalAccount())
        await attempt(() => lockBrowserVault())
        await attempt(() => clearActiveRuntimeTargetContext())
        await attempt(() => clearAccountDatabaseSelection())
        await attempt(() => dependencies.clearAccountLocalState())

        set((state) => ({
          unlockedAccountId: null,
          locked: computeLocked(state.accounts, state.activeAccountId, null),
          error: null,
          accountRevision: state.accountRevision + 1,
        }))

        if (failures.length > 0) {
          throw setFailure(
            failures.length === 1
              ? failures[0]
              : new AggregateError(failures, "Account lock teardown was incomplete.")
          )
        }
      },

      acknowledgeRecoveryKey: () => {
        set({ pendingRecoveryKey: null })
      },
    }
  })
}

/**
 * Which credential store this runtime authenticates against.
 *
 * Exported because the lock screen has to agree with the store on it: the
 * unlock stage ladder, the recovery-key entry point and the runtime badge all
 * differ between the desktop host (Argon2id verifier, no recovery wrap) and a
 * browser (PBKDF2 Browser Vault). Two copies of this predicate would drift.
 */
export function usesBrowserVault(): boolean {
  return shouldUseBrowserVault()
}

function shouldUseBrowserVault(): boolean {
  return !isTauri() && !isCapacitor()
}

function activateSelectedDatabase(accountId: string, targetId?: string): void {
  if (targetId) {
    activateAccountDatabase(accountId, targetId)
  } else {
    activateAccountDatabase(accountId)
  }
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
  setActiveRuntimeTargetContext(accountId, "local-host")
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
  // Never on a browser-vault platform. The convenience this function exists for
  // is "skip re-typing the password", and on desktop/mobile that is harmless:
  // secrets live in the OS keyring, which needs no password to reach. On the
  // web they live in the Browser Vault, whose session key is derived from the
  // password itself (`unlockBrowserVault`) — so an auto-unlock with no password
  // cannot produce one.
  //
  // Returning an id anyway is what made the app lie about itself: `computeLocked`
  // saw `activeAccountId === unlockedAccountId` and reported unlocked, so
  // AccountGate never rendered, while `getActiveBrowserVault()` stayed null and
  // every credential read/write threw `BrowserVaultLockedError`. `/pair` showed
  // it worst — the Host registered the device, the local save threw, and the
  // one-shot invitation was already spent, with no route to the lock screen
  // because the gate believed the user was signed in.
  //
  // So on the web the gate always runs in dev. That is not lost convenience:
  // there is no unlocked-without-a-password state to preserve there.
  if (shouldUseBrowserVault()) return null
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
    throw new AccountUnlockError("password-required", "Local account password is required.")
  }
}

async function dropDexieAccountDatabase(accountId: string): Promise<void> {
  const databaseName = accountDatabaseName(accountId)
  await Dexie.delete(databaseName)
  if (await Dexie.exists(databaseName)) {
    throw new Error(`Account database deletion could not be verified: ${databaseName}`)
  }
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
