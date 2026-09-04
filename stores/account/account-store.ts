import Dexie from "dexie"
import { create, type UseBoundStore, type StoreApi } from "zustand"

import {
  LocalAccountRegistry,
  accountDatabaseName,
  encryptedAccountDatabaseName,
  generateAccountId,
} from "@/lib/accounts/account-db"
import { AccountRegistryError } from "@/lib/accounts/account-types"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { withAccountProvisioningLock } from "@/lib/accounts/provisioning-lock"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  lockAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import {
  legacyDatabaseExists,
  migrateLegacyDatabaseToAccount,
} from "@/lib/accounts/legacy-migration"
import {
  createPasswordVerifier,
  rotateNativePassword,
  unbindLocalAccount,
  verifyPassword,
} from "@/lib/accounts/password-client"
import {
  DEV_LOCAL_ACCOUNT_DISPLAY_NAME,
  DEV_LOCAL_ACCOUNT_ID,
  DEV_LOCAL_ACCOUNT_PASSWORD,
  isDevAutoUnlockEnabled,
  isDevLocalAccountEnabled,
} from "@/lib/accounts/dev-auto-unlock"
import {
  forgetDevSessionUnlock,
  readDevSessionUnlock,
  rememberDevSessionUnlock,
} from "@/lib/accounts/dev-session-unlock"
import {
  clearQuickUnlockDeviceMaterial,
  enrollQuickUnlock,
  removeQuickUnlock,
  verifyQuickUnlock,
  type QuickUnlockOutcome,
} from "@/lib/accounts/quick-unlock/client"
import { withLockoutCleared } from "@/lib/accounts/quick-unlock/types"
import type { QuickUnlockMethod } from "@/lib/accounts/quick-unlock/types"
import { AccountUnlockError, asUnlockError } from "@/lib/accounts/account-unlock-error"
import { publishUnlockStage } from "@/lib/accounts/unlock-progress"
import { isCapacitor, isTauri } from "@/lib/platform/detect"
import {
  changeBrowserVaultPassword,
  browserVaultExists,
  deleteBrowserVault,
  getActiveBrowserVault,
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
import {
  encryptedRuntimeTargetDatabaseName,
  type RuntimeTargetRecord,
} from "@/lib/runtime/target-registry"
import {
  markTargetDatabaseMigrationCompleted,
  migrateAccountDatabaseToTarget,
} from "@/lib/runtime/target-database-migration"
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
import {
  activatePluginAccountStorage,
  clearPluginAccountStorage,
  purgePluginAccountStorage,
} from "@/stores/plugin-runtime/plugin-store"
import {
  activatePluginRuntimeAccount,
  clearPluginRuntimeAccount,
} from "@/lib/plugin/security/account-runtime-gate"
import type { ProfileCloudIdentityCleanup } from "@/lib/identity/forget-profile-identity"

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
   * Open an account with an enrolled PIN, pattern or passkey.
   *
   * Resolves to the outcome rather than throwing on a wrong secret, because
   * the attempt count has to be persisted either way and an exception is how
   * that gets skipped.
   */
  unlockAccountWithQuickMethod: (
    accountId: string,
    method: QuickUnlockMethod,
    canonicalSecret: string
  ) => Promise<QuickUnlockOutcome>
  /** Add a quick-unlock method. Requires the account password. */
  enrollQuickUnlockMethod: (args: {
    accountId: string
    method: QuickUnlockMethod
    canonicalSecret: string
    password: string
    verifier?: Record<string, unknown>
  }) => Promise<void>
  /** Remove one method. The password and every other method are untouched. */
  removeQuickUnlockMethod: (accountId: string, method: QuickUnlockMethod) => Promise<void>
  /**
   * Re-enable a method disabled by the attempt cap.
   *
   * Requires the password, because proving it is exactly what earns the reset.
   * There is no lock-screen path to this, which is what keeps the cap a cap
   * rather than a speed bump.
   */
  clearQuickUnlockLockout: (
    accountId: string,
    method: QuickUnlockMethod,
    password: string
  ) => Promise<void>
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
  /** Stop and revoke every plugin runtime before the LocalProfile changes. */
  teardownPluginRuntime: (localAccountId: string) => Promise<void>
  /** Bind the unlocked account DEK to the exact physical database before open. */
  activateContentCipher: (accountId: string, databaseName: string) => void
  /** Copy a legacy desktop profile into its encrypted physical database. */
  migrateLocalContentDatabase: (accountId: string) => Promise<void>
  /**
   * Remove the profile's cloud identity: revoke and clear its Logto session,
   * drop its user binding, forget its collaboration server, and tell the host
   * to forget the person when the profile is the one the host holds. Reports
   * per-step outcomes and never throws (ADR-0149 section 9).
   */
  forgetCloudIdentity: (
    localAccountId: string,
    options: { hostBound: boolean }
  ) => Promise<ProfileCloudIdentityCleanup>
}

export interface LocalAccountDeletionResult {
  accountId: string
  wasActive: boolean
  registryDeleted: true
  accountDatabaseDeleted: true
  runtimeTargetsDeleted: boolean
  localStatePurged: true
  browserVaultDeleted: boolean
  /** What happened to the profile's cloud identity. Inspect `failures` and `tokensMayRemainLive`. */
  cloudIdentity: ProfileCloudIdentityCleanup
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
    teardownPluginRuntime: async (localAccountId) => {
      const { teardownPluginAccountRuntime } =
        await import("@/lib/plugin/security/account-isolation")
      await teardownPluginAccountRuntime(localAccountId)
    },
    activateContentCipher: (accountId, databaseName) => {
      const vault = getActiveBrowserVault()
      if (!vault || vault.accountId !== accountId) {
        throw new AccountUnlockError(
          "vault-not-provisioned",
          "The account content key is not unlocked."
        )
      }
      activateAccountContentCipher(vault.createContentCipher(databaseName))
    },
    migrateLocalContentDatabase: migrateLocalAccountContentDatabase,
    forgetCloudIdentity: async (localAccountId, options) => {
      const { forgetProfileCloudIdentity } = await import("@/lib/identity/forget-profile-identity")
      return forgetProfileCloudIdentity(localAccountId, { hostBound: options.hostBound })
    },
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

  const rollbackNativeAccountActivation = async (accountId: string): Promise<unknown[]> => {
    const failures: unknown[] = []
    for (const rollback of [
      () => dependencies.teardownPluginRuntime(accountId),
      () => unbindLocalAccount(),
      () => lockAccountContentCipher(),
      () => lockBrowserVault(),
      () => clearActiveRuntimeTargetContext(),
      () => clearAccountDatabaseSelection(),
    ]) {
      try {
        await rollback()
      } catch (error) {
        failures.push(error)
      }
    }
    return failures
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
      const databaseName = targetId
        ? encryptedRuntimeTargetDatabaseName(accountId, targetId)
        : encryptedAccountDatabaseName(accountId)
      dependencies.activateContentCipher(accountId, databaseName)
      if (!targetId) {
        await dependencies.migrateLocalContentDatabase(accountId)
      }
      activateSelectedDatabase(accountId, targetId)
      await dependencies.prepareDatabase()
    }

    /**
     * `rememberSecret` is the password the caller just proved, handed down so
     * the dev-only session resume can reuse it after an HMR reload. It is
     * stored only once the whole activation has succeeded, and only in a
     * development browser build. Callers that already unlocked from a
     * remembered secret pass nothing.
     */
    const activateUnlockedAccount = async (
      accountId: string,
      rememberSecret?: string
    ): Promise<void> => {
      const previousUnlockedAccountId = get().unlockedAccountId
      if (previousUnlockedAccountId && previousUnlockedAccountId !== accountId) {
        await dependencies.teardownPluginRuntime(previousUnlockedAccountId)
        await dependencies.clearSubscriptionRuntime(previousUnlockedAccountId)
        dependencies.clearAccountLocalState()
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
      if (rememberSecret) rememberDevSessionUnlock(accountId, rememberSecret)
      publishUnlockStage(accountId, "ready")
    }

    /**
     * Re-open the vault from a secret this tab already used successfully.
     *
     * Returns the unlocked account id, or null to leave the gate up. Every
     * failure path is silent and forgets the secret rather than throwing: a
     * stale or wrong remembered value must degrade to "type your password",
     * never to a boot that cannot settle. See `lib/accounts/dev-session-unlock.ts`.
     */
    const resumeDevSessionUnlock = async (
      accounts: LocalAccountRecord[],
      activeAccountId: string | null
    ): Promise<string | null> => {
      if (!activeAccountId) return null
      if (!accounts.some((account) => account.id === activeAccountId)) return null
      const password = readDevSessionUnlock(activeAccountId)
      if (!password) return null
      try {
        if (!(await browserVaultExists(activeAccountId))) {
          forgetDevSessionUnlock(activeAccountId)
          return null
        }
        await unlockBrowserVault(activeAccountId, password)
        await activateUnlockedAccount(activeAccountId)
        return activeAccountId
      } catch {
        forgetDevSessionUnlock(activeAccountId)
        publishUnlockStage(activeAccountId, "failed")
        return null
      }
    }

    /**
     * May this runtime stand up the disposable development account?
     *
     * Deliberately the same line `resolveE2EAutoUnlockTarget` draws. Under
     * Tauri the account password binds the OS keyring, so a constant one has
     * no business there, and Capacitor keeps its own runtime chooser.
     */
    const devLocalAccountAllowed = (): boolean =>
      !isTauri() && !isCapacitor() && isDevLocalAccountEnabled()

    /**
     * Create the deterministic development account and leave it unlocked.
     *
     * Returns null on any failure, which simply leaves first-run setup on
     * screen. Dev convenience must never be able to make a boot worse.
     */
    const provisionDevLocalAccount = async (): Promise<string | null> => {
      try {
        const account = await get().createAccount({
          id: DEV_LOCAL_ACCOUNT_ID,
          displayName: DEV_LOCAL_ACCOUNT_DISPLAY_NAME,
          password: DEV_LOCAL_ACCOUNT_PASSWORD,
          activate: true,
        })
        // The recovery-key screen is the last of the six first-run
        // interactions, and this key wraps a throwaway database whose password
        // is a constant in the bundle. Surfacing it would defeat the point.
        set({ pendingRecoveryKey: null, error: null })
        return account.id
      } catch {
        // `createAccount` already recorded the failure through `setFailure`.
        // Clear it so the gate offers first-run setup rather than an error the
        // developer has no way to act on.
        set({ error: null })
        return null
      }
    }

    /**
     * Re-open the development account from its constant password.
     *
     * Unlike `resumeDevSessionUnlock` this needs nothing remembered, which is
     * the whole point: `sessionStorage` dies with the tab, so a second window
     * or a fresh agent context would otherwise be back at the lock screen.
     */
    const openDevLocalAccount = async (): Promise<string | null> => {
      try {
        if (!(await browserVaultExists(DEV_LOCAL_ACCOUNT_ID))) return null
        await unlockBrowserVault(DEV_LOCAL_ACCOUNT_ID, DEV_LOCAL_ACCOUNT_PASSWORD)
        await activateUnlockedAccount(DEV_LOCAL_ACCOUNT_ID)
        return DEV_LOCAL_ACCOUNT_ID
      } catch {
        publishUnlockStage(DEV_LOCAL_ACCOUNT_ID, "failed")
        return null
      }
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
          let [accounts, registryState] = await Promise.all([
            dependencies.registry.listAccounts(),
            dependencies.registry.getState(),
          ])
          const e2eAutoUnlockAccountId = resolveE2EAutoUnlockTarget(
            accounts,
            registryState.activeAccountId
          )
          if (e2eAutoUnlockAccountId) {
            if (await browserVaultExists(e2eAutoUnlockAccountId)) {
              await unlockBrowserVault(e2eAutoUnlockAccountId, E2E_ACCOUNT_PASSWORD)
            } else {
              await provisionBrowserVault(e2eAutoUnlockAccountId, E2E_ACCOUNT_PASSWORD)
            }
            await activateUnlockedAccount(e2eAutoUnlockAccountId)
          }
          // `pnpm dev` in a browser. An empty registry gets the disposable
          // account stood up, and an existing one gets re-opened from its
          // constant password, so neither a fresh profile nor a second tab
          // has to walk through first-run setup. Both paths degrade to null,
          // which leaves the real gate exactly where it was.
          let devLocalAccountId: string | null = null
          if (!e2eAutoUnlockAccountId && devLocalAccountAllowed()) {
            if (accounts.length === 0) {
              // Two tabs booting a fresh profile both read an empty registry.
              // Whoever loses the race must ADOPT the account the winner just
              // created rather than stand a second one up over its vault, so
              // the decision is re-made inside the lock, not out here.
              devLocalAccountId = await withAccountProvisioningLock(
                DEV_LOCAL_ACCOUNT_ID,
                async () => {
                  const current = await dependencies.registry.listAccounts()
                  return current.some((record) => record.id === DEV_LOCAL_ACCOUNT_ID)
                    ? openDevLocalAccount()
                    : provisionDevLocalAccount()
                }
              )
              if (devLocalAccountId) {
                ;[accounts, registryState] = await Promise.all([
                  dependencies.registry.listAccounts(),
                  dependencies.registry.getState(),
                ])
              }
            } else if (resolveDevLocalUnlockTarget(accounts, registryState.activeAccountId)) {
              devLocalAccountId = await openDevLocalAccount()
            }
          }
          const activeAccountId =
            e2eAutoUnlockAccountId ?? devLocalAccountId ?? registryState.activeAccountId
          // Dev convenience, one tab, one typed password. Never provisions a
          // vault: a remembered secret may only re-open a vault that already
          // exists, so first-run account creation stays a deliberate choice.
          const unlockedAccountId =
            e2eAutoUnlockAccountId ??
            devLocalAccountId ??
            (await resumeDevSessionUnlock(accounts, activeAccountId))
          set((state) => ({
            accounts,
            activeAccountId,
            unlockedAccountId,
            loaded: true,
            loading: false,
            locked: computeLocked(accounts, activeAccountId, unlockedAccountId),
            error: null,
            accountRevision: state.accountRevision,
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
          // The check, the vault write and the registry row are ONE critical
          // section, held across every context that shares this origin. A
          // caller-named id can collide, and `provisionBrowserVault` REPLACES
          // the vault record outright: two contexts that both pass the check
          // both mint a fresh DEK, and the loser's rollback below then deletes
          // the vault the winner is signed in against. Re-checking without the
          // lock only narrows that window. Holding it closes it. See
          // `lib/accounts/provisioning-lock.ts`.
          const { account, recoveryKey } = await withAccountProvisioningLock(
            accountId,
            async () => {
              // Re-read INSIDE the lock: the read that got us here is exactly
              // the one the loser of the race took before the winner wrote.
              if (input.id) {
                const onRecord = await dependencies.registry.listAccounts()
                if (onRecord.some((record) => record.id === accountId)) {
                  throw new AccountRegistryError(
                    "account-exists",
                    `Account ${accountId} already exists.`
                  )
                }
              }
              const provisioned = shouldActivate
                ? await provisionBrowserVault(accountId, input.password)
                : await provisionBrowserVault(accountId, input.password, false)
              let created: LocalAccountRecord
              try {
                created = await dependencies.registry.createAccount({
                  id: accountId,
                  displayName: input.displayName,
                  passwordVerifier,
                  activate: shouldActivate,
                })
              } catch (error) {
                await deleteBrowserVault(accountId).catch(() => {})
                throw error
              }
              return { account: created, recoveryKey: provisioned }
            }
          )

          if (!useBrowserVault && shouldActivate) {
            const verified = await verifyPassword(input.password, passwordVerifier, account.id)
            if (!verified) {
              await dependencies.registry.deleteAccount(account.id).catch(() => {})
              await deleteBrowserVault(account.id).catch(() => {})
              throw new AccountUnlockError(
                "invalid-password",
                "The native account session could not be established."
              )
            }
          }

          if (isFirstAccount && (await legacyDatabaseExists())) {
            dependencies.activateContentCipher(account.id, encryptedAccountDatabaseName(account.id))
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
              // Surface the key on EVERY runtime. `provisionBrowserVault` now
              // runs everywhere, so the account content DEK sits behind a
              // recovery wrap on desktop and mobile too — discarding the only
              // key that opens it left the user with a secret they were never
              // shown. The unlock path already surfaces it on those runtimes
              // (see `unlockAccount`), so gating it here was an inconsistency.
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
            // Creation leaves the account unlocked without going through
            // `activateUnlockedAccount`, so the dev resume has to be seeded
            // here too. Without it the very first navigation after first-run
            // setup asks for the password that was typed seconds earlier.
            rememberDevSessionUnlock(account.id, input.password)
          }

          return account
        } catch (error) {
          throw setFailure(error)
        }
      },

      unlockAccount: async (accountId, password) => {
        set({ error: null })
        let nativeAccountActivated = false
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
            nativeAccountActivated = true
            if (await browserVaultExists(account.id)) {
              await unlockBrowserVault(account.id, password)
            } else {
              const recoveryKey = await provisionBrowserVault(account.id, password)
              set({ pendingRecoveryKey: recoveryKey })
            }
          }
          await activateUnlockedAccount(account.id, password)
        } catch (error) {
          if (nativeAccountActivated) {
            const rollbackFailures = await rollbackNativeAccountActivation(accountId)
            if (rollbackFailures.length > 0) {
              error = new AggregateError(
                [error, ...rollbackFailures],
                "Account unlock failed and native rollback was incomplete."
              )
            }
          }
          publishUnlockStage(accountId, "failed")
          throw setFailure(asUnlockError(error))
        }
      },

      unlockAccountWithQuickMethod: async (accountId, method, canonicalSecret) => {
        set({ error: null })
        const account = await findAccount(accountId)
        const enrollment = (account.quickUnlock ?? []).find((entry) => entry.method === method)
        if (!enrollment) {
          throw setFailure(
            new AccountUnlockError("invalid-password", "That unlock method is not enrolled.")
          )
        }

        publishUnlockStage(account.id, "verifying")
        const outcome = await verifyQuickUnlock({
          accountId: account.id,
          enrollment,
          canonicalSecret,
          passwordVerifier: account.passwordVerifier,
        })

        // Persisted BEFORE the success branch runs. The attempt count is the
        // entire protection for a 20-bit secret, so it must survive even if
        // activation then fails.
        const nextEnrollments = (account.quickUnlock ?? []).map((entry) =>
          entry.method === method ? outcome.enrollment : entry
        )
        const stored = await dependencies.registry.updateQuickUnlock(account.id, nextEnrollments)
        set((state) => ({ accounts: upsertAccount(state.accounts, stored) }))

        if (!outcome.ok) {
          publishUnlockStage(account.id, "failed")
          return outcome
        }

        try {
          await activateUnlockedAccount(account.id)
        } catch (error) {
          publishUnlockStage(account.id, "failed")
          throw setFailure(asUnlockError(error))
        }
        return outcome
      },

      enrollQuickUnlockMethod: async ({
        accountId,
        method,
        canonicalSecret,
        password,
        verifier,
      }) => {
        set({ error: null })
        const account = await findAccount(accountId)
        const enrollment = await enrollQuickUnlock({
          accountId: account.id,
          method,
          canonicalSecret,
          password,
          passwordVerifier: account.passwordVerifier,
        })
        // A passkey carries its credential id, which the enrolling caller
        // obtained from the authenticator and this layer never sees.
        const merged = verifier
          ? { ...enrollment, verifier: { ...enrollment.verifier, ...verifier } }
          : enrollment
        const others = (account.quickUnlock ?? []).filter((entry) => entry.method !== method)
        const stored = await dependencies.registry.updateQuickUnlock(account.id, [
          ...others,
          merged,
        ])
        set((state) => ({ accounts: upsertAccount(state.accounts, stored) }))
      },

      removeQuickUnlockMethod: async (accountId, method) => {
        set({ error: null })
        const account = await findAccount(accountId)
        await removeQuickUnlock(account.id, method)
        const remaining = (account.quickUnlock ?? []).filter((entry) => entry.method !== method)
        const stored = await dependencies.registry.updateQuickUnlock(account.id, remaining)
        set((state) => ({ accounts: upsertAccount(state.accounts, stored) }))
        // The device material is per account, so it only goes once the last
        // method does. Dropping it early would break the others.
        if (remaining.length === 0) {
          await clearQuickUnlockDeviceMaterial(account.id).catch(() => {})
        }
      },

      clearQuickUnlockLockout: async (accountId, method, password) => {
        set({ error: null })
        const account = await findAccount(accountId)
        // Proving the password is what earns the reset. Without this check the
        // attempt cap would be trivially resettable from the same screen an
        // attacker already reached.
        const ok = shouldUseBrowserVault()
          ? await verifyBrowserVaultPassword(account.id, password)
          : await verifyPassword(password, account.passwordVerifier)
        if (!ok) {
          throw setFailure(
            new AccountUnlockError("invalid-password", "Invalid local account password.")
          )
        }
        const next = (account.quickUnlock ?? []).map((entry) =>
          entry.method === method ? withLockoutCleared(entry) : entry
        )
        const stored = await dependencies.registry.updateQuickUnlock(account.id, next)
        set((state) => ({ accounts: upsertAccount(state.accounts, stored) }))
      },

      unlockAccountWithRecoveryKey: async (accountId, recoveryKey, newPassword) => {
        set({ error: null })
        try {
          if (!shouldUseBrowserVault()) {
            throw new AccountUnlockError(
              "vault-not-provisioned",
              "Desktop recovery requires the native recovery flow."
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
          await activateUnlockedAccount(account.id, newPassword)
        } catch (error) {
          publishUnlockStage(accountId, "failed")
          throw setFailure(asUnlockError(error))
        }
      },

      switchAccount: async (accountId, password) => {
        set({ error: null })
        let nativeAccountActivated = false
        try {
          if (get().unlockedAccountId === accountId) {
            await activateUnlockedAccount(accountId)
            return
          }
          // Switching begins at the security boundary, not after the target
          // password succeeds. This prevents a surviving plugin runtime from
          // observing the target account's native permission ledger during the
          // verification window. A failed target unlock therefore leaves the
          // application locked, which is the fail-closed state.
          if (get().unlockedAccountId) {
            await get().lock()
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
            nativeAccountActivated = true
            if (await browserVaultExists(account.id)) {
              await unlockBrowserVault(account.id, password)
            } else {
              const recoveryKey = await provisionBrowserVault(account.id, password)
              set({ pendingRecoveryKey: recoveryKey })
            }
          }
          await activateUnlockedAccount(account.id, password)
        } catch (error) {
          if (nativeAccountActivated) {
            const rollbackFailures = await rollbackNativeAccountActivation(accountId)
            if (rollbackFailures.length > 0) {
              error = new AggregateError(
                [error, ...rollbackFailures],
                "Account switch failed and native rollback was incomplete."
              )
            }
          }
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
          let passwordVerifier: LocalAccountRecord["passwordVerifier"]
          let updated: LocalAccountRecord
          // Only the DESKTOP host owns a native verifier pin, so only it needs
          // `rotateNativePassword`. Capacitor is `!useBrowserVault` too but has
          // no native rotation command — routing it down that branch made
          // `rotateNativePassword` throw "only available in the desktop
          // runtime" before anything committed, so mobile users could not
          // change their password at all. Mobile rotates the registry verifier
          // and the vault exactly like the browser does; the only difference is
          // which credential store proves the current password.
          if (useBrowserVault || !isTauri()) {
            const ok = useBrowserVault
              ? await verifyBrowserVaultPassword(accountId, currentPassword)
              : await verifyPassword(currentPassword, account.passwordVerifier, accountId)
            if (!ok) {
              throw new AccountUnlockError("invalid-password", "Invalid local account password.")
            }
            passwordVerifier = await createPasswordVerifier(newPassword)
            updated = await dependencies.registry.updatePasswordVerifier(
              accountId,
              passwordVerifier
            )
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
          } else {
            passwordVerifier = await rotateNativePassword(
              accountId,
              currentPassword,
              account.passwordVerifier,
              newPassword
            )
            try {
              await changeBrowserVaultPassword(accountId, currentPassword, newPassword)
            } catch (vaultError) {
              try {
                await rotateNativePassword(
                  accountId,
                  newPassword,
                  passwordVerifier,
                  currentPassword,
                  account.passwordVerifier
                )
              } catch (rollbackError) {
                throw new AggregateError(
                  [vaultError, rollbackError],
                  "Content key rewrap failed and the native verifier could not be rolled back."
                )
              }
              throw vaultError
            }
            try {
              updated = await dependencies.registry.updatePasswordVerifier(
                accountId,
                passwordVerifier
              )
            } catch (registryError) {
              const rollbackErrors: unknown[] = []
              try {
                await changeBrowserVaultPassword(accountId, newPassword, currentPassword)
              } catch (rollbackError) {
                rollbackErrors.push(rollbackError)
              }
              try {
                await rotateNativePassword(
                  accountId,
                  newPassword,
                  passwordVerifier,
                  currentPassword,
                  account.passwordVerifier
                )
              } catch (rollbackError) {
                rollbackErrors.push(rollbackError)
              }
              if (rollbackErrors.length > 0) {
                throw new AggregateError(
                  [registryError, ...rollbackErrors],
                  "Password rotation committed but the registry update and compensating rollback were incomplete."
                )
              }
              throw registryError
            }
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
          const localAccountId = accountId
          const wasActive = get().activeAccountId === localAccountId
          const replacementAccountId = options.replacementAccountId
          const wasUnlocked = get().unlockedAccountId === localAccountId
          // The registry delete carries every refusal (last account, missing
          // replacement), so it runs before anything irreversible. The cloud
          // identity goes next, while the profile is still the host's bound
          // namespace: `lock()` unbinds the host, and after that the host
          // can no longer be told whose person to forget.
          await dependencies.registry.deleteAccount(localAccountId, { replacementAccountId })
          const cloudIdentity = await dependencies.forgetCloudIdentity(localAccountId, {
            hostBound: wasUnlocked,
          })
          if (wasActive && wasUnlocked) {
            await get().lock()
          }
          await dependencies.dropAccountDatabase(localAccountId)
          let runtimeTargetsDeleted = false
          if (shouldUseBrowserVault()) {
            await dependencies.removeRuntimeTargets(accountId)
            runtimeTargetsDeleted = true
          }
          await dependencies.purgeAccountLocalState(accountId)
          await deleteBrowserVault(accountId)
          const browserVaultDeleted = true

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
            cloudIdentity,
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

        // First, and outside `attempt`: a lock that left the remembered dev
        // secret behind would be undone by the very next boot, which is the one
        // outcome a lock must never produce. Clearing storage cannot throw in a
        // way the helper does not already swallow.
        forgetDevSessionUnlock()

        await attempt(() => dependencies.stopRuntimeSubscriptions())
        if (unlockedAccountId) {
          await attempt(() => dependencies.teardownPluginRuntime(unlockedAccountId))
          await attempt(() => dependencies.clearSubscriptionRuntime(unlockedAccountId))
        }
        await attempt(() => unbindLocalAccount())
        await attempt(() => lockAccountContentCipher())
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
export async function unlockAccountForHost(
  accountId: string,
  accountContentKey?: Uint8Array
): Promise<void> {
  const marker = (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
  if (marker !== true) {
    throw new Error(
      "unlockAccountForHost is reserved for headless host processes (__COGNIA_HEADLESS__ not set)"
    )
  }
  if (accountContentKey?.length !== 32) {
    throw new Error("Headless account content key must be exactly 32 bytes.")
  }
  const databaseName = encryptedAccountDatabaseName(accountId)
  const contentKey = accountContentKey.slice()
  try {
    activateAccountContentCipher(
      await AccountContentCipher.fromRawKey(accountId, databaseName, contentKey)
    )
  } finally {
    contentKey.fill(0)
  }
  activatePluginAccountStorage(accountId)
  activatePluginRuntimeAccount(accountId)
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

const E2E_ACCOUNT_PASSWORD = "cognia-e2e-local-account"

function resolveE2EAutoUnlockTarget(
  accounts: LocalAccountRecord[],
  activeAccountId: string | null
): string | null {
  if (isTauri() || !isDevAutoUnlockEnabled()) return null
  if (activeAccountId && accounts.some((account) => account.id === activeAccountId)) {
    return activeAccountId
  }
  return accounts[0]?.id ?? null
}

/**
 * The development account, when boot may open it without a prompt.
 *
 * An active account that exists and is not this one is a deliberate choice by
 * the developer, so it keeps the real password prompt. A dangling or absent
 * active id falls back to the development account.
 */
function resolveDevLocalUnlockTarget(
  accounts: LocalAccountRecord[],
  activeAccountId: string | null
): string | null {
  if (!accounts.some((account) => account.id === DEV_LOCAL_ACCOUNT_ID)) return null
  if (activeAccountId && activeAccountId !== DEV_LOCAL_ACCOUNT_ID) {
    return accounts.some((account) => account.id === activeAccountId) ? null : DEV_LOCAL_ACCOUNT_ID
  }
  return DEV_LOCAL_ACCOUNT_ID
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
  for (const databaseName of [
    accountDatabaseName(accountId),
    encryptedAccountDatabaseName(accountId),
  ]) {
    await Dexie.delete(databaseName)
    if (await Dexie.exists(databaseName)) {
      throw new Error(`Account database deletion could not be verified: ${databaseName}`)
    }
  }
}

async function migrateLocalAccountContentDatabase(accountId: string): Promise<void> {
  const sourceDbName = accountDatabaseName(accountId)
  if (!(await Dexie.exists(sourceDbName))) return
  const targetDbName = encryptedAccountDatabaseName(accountId)
  const result = await migrateAccountDatabaseToTarget({
    accountId,
    targetId: "local-host",
    sourceDbName,
    targetDbName,
  })
  await markTargetDatabaseMigrationCompleted(accountId, "local-host")
  if (result.stage !== "verified") {
    throw new Error("Account content migration did not reach verified state.")
  }
  await Dexie.delete(sourceDbName)
  if (await Dexie.exists(sourceDbName)) {
    throw new Error(`Plaintext account database deletion could not be verified: ${sourceDbName}`)
  }
}

async function purgeLocalStorageForAccount(accountId: string): Promise<void> {
  purgeArtifactAccountStorage(accountId)
  purgeAgentTeamAccountStorage(accountId)
  purgeProjectEditorAccountStorage(accountId)
  purgePluginAccountStorage(accountId)
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
  activatePluginAccountStorage(accountId)
  activatePluginRuntimeAccount(accountId)
}

function clearBrowserAccountLocalState(): void {
  clearPluginRuntimeAccount()
  clearPluginAccountStorage()
  clearArtifactAccountStorage()
  clearAgentTeamAccountStorage()
  clearProjectEditorAccountStorage()
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === "string") return new Error(error)
  return new Error("Local account operation failed.")
}
