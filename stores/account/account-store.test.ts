/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"

import type { ProfileCloudIdentityCleanup } from "@/lib/identity/forget-profile-identity"

import type { AccountStoreDependencies } from "./account-store"

const mockForgetProfileCloudIdentity = jest.fn()
jest.mock("@/lib/identity/forget-profile-identity", () => ({
  forgetProfileCloudIdentity: (...args: unknown[]) => mockForgetProfileCloudIdentity(...args),
}))

const mockBumpPerformanceSecurityGeneration = jest.fn()
jest.mock("@/lib/perf/security-generation", () => ({
  bumpPerformanceSecurityGeneration: (...args: unknown[]) =>
    mockBumpPerformanceSecurityGeneration(...args),
}))

const mockListAccounts = jest.fn<Promise<LocalAccountRecord[]>, []>()
const mockGetState = jest.fn<
  Promise<{ activeAccountId: string | null; legacyMigration?: unknown }>,
  []
>()
const mockCreateRegistryAccount = jest.fn<Promise<LocalAccountRecord>, [unknown]>()
const mockRenameRegistryAccount = jest.fn<Promise<LocalAccountRecord>, [string, string]>()
const mockUpdatePasswordVerifier = jest.fn<
  Promise<LocalAccountRecord>,
  [string, PasswordVerifierRecord]
>()
const mockSetActiveAccountId = jest.fn<Promise<void>, [string]>()
const mockDeleteRegistryAccount = jest.fn<Promise<void>, [string, unknown?]>()
const mockUpdateAvatarRegistry = jest.fn<Promise<LocalAccountRecord>, [string, string | null]>()

jest.mock("@/lib/accounts/account-db", () => ({
  LocalAccountRegistry: jest.fn().mockImplementation(() => ({
    listAccounts: mockListAccounts,
    getState: mockGetState,
    createAccount: mockCreateRegistryAccount,
    renameAccount: mockRenameRegistryAccount,
    updatePasswordVerifier: mockUpdatePasswordVerifier,
    updateAvatar: mockUpdateAvatarRegistry,
    setActiveAccountId: mockSetActiveAccountId,
    deleteAccount: mockDeleteRegistryAccount,
  })),
  accountDatabaseName: (accountId: string) => `cognia-account-${accountId}`,
  encryptedAccountDatabaseName: (accountId: string) => `cognia-account-${accountId}-encrypted-v1`,
  generateAccountId: () => "acct_generated",
}))

const mockCreatePasswordVerifier = jest.fn<Promise<PasswordVerifierRecord>, [string]>()
const mockVerifyPassword = jest.fn<
  Promise<boolean>,
  [string, PasswordVerifierRecord, string | undefined]
>()
const mockUnbindLocalAccount = jest.fn<Promise<void>, []>()
const mockRotateNativePassword = jest.fn<
  Promise<PasswordVerifierRecord>,
  [string, string, PasswordVerifierRecord, string, PasswordVerifierRecord?]
>()

jest.mock("@/lib/accounts/password-client", () => ({
  createPasswordVerifier: mockCreatePasswordVerifier,
  verifyPassword: mockVerifyPassword,
  unbindLocalAccount: mockUnbindLocalAccount,
  rotateNativePassword: mockRotateNativePassword,
}))

let mockIsTauri = true
let mockIsCapacitor = false
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => mockIsTauri,
  isCapacitor: () => mockIsCapacitor,
}))

const mockProvisionBrowserVault = jest.fn<Promise<string>, [string, string]>()
const mockUnlockBrowserVault = jest.fn<Promise<void>, [string, string]>()
const mockVerifyBrowserVaultPassword = jest.fn<Promise<boolean>, [string, string]>()
const mockChangeBrowserVaultPassword = jest.fn<Promise<void>, [string, string, string]>()
const mockResetVaultWithRecoveryKey = jest.fn<Promise<void>, [string, string, string]>()
const mockDeleteBrowserVault = jest.fn<Promise<void>, [string]>()
const mockLockBrowserVault = jest.fn<void, []>()
const mockBrowserVaultExists = jest.fn<Promise<boolean>, [string]>()
let mockActiveBrowserVaultAccountId: string | null = null
jest.mock("@/lib/runtime/browser-vault", () => ({
  provisionBrowserVault: (...args: [string, string]) => mockProvisionBrowserVault(...args),
  unlockBrowserVault: (...args: [string, string]) => mockUnlockBrowserVault(...args),
  verifyBrowserVaultPassword: (...args: [string, string]) =>
    mockVerifyBrowserVaultPassword(...args),
  changeBrowserVaultPassword: (...args: [string, string, string]) =>
    mockChangeBrowserVaultPassword(...args),
  deleteBrowserVault: (...args: [string]) => mockDeleteBrowserVault(...args),
  lockBrowserVault: () => mockLockBrowserVault(),
  browserVaultExists: (...args: [string]) => mockBrowserVaultExists(...args),
  getActiveBrowserVault: () =>
    mockActiveBrowserVaultAccountId
      ? {
          accountId: mockActiveBrowserVaultAccountId,
          createContentCipher: (databaseName: string) => ({ databaseName, lock: jest.fn() }),
        }
      : null,
  resetBrowserVaultPasswordWithRecoveryKey: (...args: [string, string, string]) =>
    mockResetVaultWithRecoveryKey(...args),
}))

const mockSetActiveRuntimeTargetContext = jest.fn<void, [string, string]>()
const mockClearActiveRuntimeTargetContext = jest.fn<void, []>()
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  setActiveRuntimeTargetContext: (...args: [string, string]) =>
    mockSetActiveRuntimeTargetContext(...args),
  clearActiveRuntimeTargetContext: () => mockClearActiveRuntimeTargetContext(),
}))

const mockLegacyDatabaseExists = jest.fn<Promise<boolean>, []>()
const mockMigrateLegacyDatabaseToAccount = jest.fn<Promise<unknown>, [unknown]>()

jest.mock("@/lib/accounts/legacy-migration", () => ({
  legacyDatabaseExists: mockLegacyDatabaseExists,
  migrateLegacyDatabaseToAccount: mockMigrateLegacyDatabaseToAccount,
}))

const mockActivateAccountDatabase = jest.fn<void, [string]>()
const mockClearAccountDatabaseSelection = jest.fn<void, []>()

jest.mock("@/lib/db/schema", () => ({
  activateAccountDatabase: mockActivateAccountDatabase,
  clearAccountDatabaseSelection: mockClearAccountDatabaseSelection,
}))

const mockEnsureActiveDatabaseReady = jest.fn(async () => ({
  databaseName: "test",
  restoredPluginTables: [],
}))
jest.mock("@/lib/db/boot", () => ({
  ensureActiveDatabaseReady: mockEnsureActiveDatabaseReady,
}))

const mockDropAccountDatabase = jest.fn<Promise<void>, [string]>()
const mockForgetCloudIdentity = jest.fn<
  Promise<ProfileCloudIdentityCleanup>,
  [string, { hostBound: boolean }]
>()
const mockPurgeAccountLocalState = jest.fn<Promise<void>, [string]>()
const mockActivateAccountLocalState = jest.fn<Promise<void>, [string]>()
const mockClearAccountLocalState = jest.fn<void, []>()
const mockPrepareRuntimeTarget = jest.fn()
const mockPrepareDatabase = jest.fn<Promise<unknown>, []>()
const mockRemoveRuntimeTargets = jest.fn<Promise<void>, [string]>()
const mockClearSubscriptionRuntime = jest.fn<Promise<void>, [string]>()
const mockStopRuntimeSubscriptions = jest.fn<Promise<void>, []>()
const mockTeardownPluginRuntime = jest.fn<Promise<void>, [string]>()
const mockActivateContentCipher = jest.fn<void, [string, string]>()
const mockMigrateLocalContentDatabase = jest.fn<Promise<void>, [string]>()

let createAccountStore: typeof import("./account-store").createAccountStore
let selectActiveAccount: typeof import("./account-store").selectActiveAccount

beforeAll(async () => {
  const mod = await import("./account-store")
  createAccountStore = mod.createAccountStore
  selectActiveAccount = mod.selectActiveAccount
})

const verifier = (tag: string): PasswordVerifierRecord => ({
  algorithm: "argon2id-v1",
  salt: `salt-${tag}`,
  hash: `hash-${tag}`,
  params: { memoryCost: 1 },
})

const account = (
  id: string,
  displayName: string,
  passwordVerifier: PasswordVerifierRecord = verifier(id)
): LocalAccountRecord => ({
  id,
  displayName,
  passwordVerifier,
  createdAt: 100,
  updatedAt: 100,
})

function cleanCloudIdentity(localAccountId: string): ProfileCloudIdentityCleanup {
  return {
    localAccountId,
    steps: {
      session: { status: "done" },
      binding: { status: "done" },
      "collab-connection": { status: "done" },
      "host-person": { status: "skipped", reason: "not-bound-on-host" },
    },
    failures: [],
    tokensMayRemainLive: false,
  }
}

function makeStore() {
  const dependencies: Partial<AccountStoreDependencies> = {
    dropAccountDatabase: mockDropAccountDatabase,
    purgeAccountLocalState: mockPurgeAccountLocalState,
    activateAccountLocalState: mockActivateAccountLocalState,
    clearAccountLocalState: mockClearAccountLocalState,
    prepareRuntimeTarget: mockPrepareRuntimeTarget,
    prepareDatabase: mockPrepareDatabase,
    removeRuntimeTargets: mockRemoveRuntimeTargets,
    clearSubscriptionRuntime: mockClearSubscriptionRuntime,
    stopRuntimeSubscriptions: mockStopRuntimeSubscriptions,
    teardownPluginRuntime: mockTeardownPluginRuntime,
    activateContentCipher: mockActivateContentCipher,
    migrateLocalContentDatabase: mockMigrateLocalContentDatabase,
    forgetCloudIdentity: mockForgetCloudIdentity,
  }
  return createAccountStore(dependencies)
}

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
  mockIsTauri = true
  mockIsCapacitor = false
  mockProvisionBrowserVault.mockResolvedValue("recovery-key")
  mockProvisionBrowserVault.mockImplementation(async (accountId) => {
    mockActiveBrowserVaultAccountId = accountId
    return "recovery-key"
  })
  mockUnlockBrowserVault.mockImplementation(async (accountId) => {
    mockActiveBrowserVaultAccountId = accountId
  })
  mockActiveBrowserVaultAccountId = null
  mockBrowserVaultExists.mockResolvedValue(true)
  mockVerifyBrowserVaultPassword.mockResolvedValue(true)
  mockChangeBrowserVaultPassword.mockResolvedValue()
  mockDeleteBrowserVault.mockResolvedValue()
  mockTeardownPluginRuntime.mockResolvedValue()
  mockMigrateLocalContentDatabase.mockResolvedValue()
  mockForgetCloudIdentity.mockImplementation(async (localAccountId) =>
    cleanCloudIdentity(localAccountId)
  )
  mockForgetProfileCloudIdentity.mockImplementation(async (localAccountId: string) =>
    cleanCloudIdentity(localAccountId)
  )
  mockListAccounts.mockResolvedValue([])
  mockGetState.mockResolvedValue({ activeAccountId: null })
  mockCreatePasswordVerifier.mockImplementation(async (password) => verifier(password))
  mockVerifyPassword.mockResolvedValue(true)
  mockUnbindLocalAccount.mockResolvedValue()
  mockRotateNativePassword.mockImplementation(
    async (_accountId, _currentPassword, _currentVerifier, newPassword, targetVerifier) =>
      targetVerifier ?? verifier(newPassword)
  )
  mockLegacyDatabaseExists.mockResolvedValue(false)
  mockMigrateLegacyDatabaseToAccount.mockResolvedValue({})
  mockCreateRegistryAccount.mockImplementation(async (input) => {
    const value = input as {
      id?: string
      displayName: string
      passwordVerifier: PasswordVerifierRecord
      activate?: boolean
    }
    return account(value.id ?? "acct_created", value.displayName, value.passwordVerifier)
  })
  mockRenameRegistryAccount.mockImplementation(async (id, displayName) =>
    account(id, displayName, verifier(id))
  )
  mockUpdatePasswordVerifier.mockImplementation(async (id, passwordVerifier) =>
    account(id, id, passwordVerifier)
  )
  mockUpdateAvatarRegistry.mockImplementation(async (id, avatarDataUrl) => ({
    ...account(id, id),
    avatarDataUrl: avatarDataUrl ?? undefined,
  }))
  mockDropAccountDatabase.mockResolvedValue()
  mockPurgeAccountLocalState.mockResolvedValue()
  mockActivateAccountLocalState.mockResolvedValue()
  mockPrepareRuntimeTarget.mockResolvedValue({
    accountId: "acct_browser",
    id: "web-standalone",
    kind: "standalone",
    label: "This browser",
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  })
  mockPrepareDatabase.mockResolvedValue({ databaseName: "test", restoredPluginTables: [] })
  mockRemoveRuntimeTargets.mockResolvedValue()
  mockClearSubscriptionRuntime.mockResolvedValue()
  mockStopRuntimeSubscriptions.mockResolvedValue()
  mockResetVaultWithRecoveryKey.mockResolvedValue()
})

describe("account store load", () => {
  it("hydrates accounts and keeps an existing active account locked until password unlock", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_beta" })
    const store = makeStore()

    await store.getState().load()

    expect(store.getState().accounts).toEqual([alpha, beta])
    expect(store.getState().activeAccountId).toBe("acct_beta")
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().loaded).toBe(true)
    expect(store.getState().locked).toBe(true)
    expect(mockActivateAccountDatabase).not.toHaveBeenCalled()
  })

  it("selectActiveAccount returns the active record", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()

    await store.getState().load()

    expect(selectActiveAccount(store.getState())).toBe(alpha)
  })

  it("does not reload an already hydrated registry", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()

    await store.getState().load()
    await store.getState().load()

    expect(mockListAccounts).toHaveBeenCalledTimes(1)
    expect(mockGetState).toHaveBeenCalledTimes(1)
  })

  it("stores load failures and clears the loading flag", async () => {
    mockListAccounts.mockRejectedValueOnce(new Error("registry offline"))
    const store = makeStore()

    await expect(store.getState().load()).rejects.toThrow(/registry offline/)

    expect(store.getState().loading).toBe(false)
    expect(store.getState().error).toBe("registry offline")
  })

  it("settles the boot load even when it fails, so the gate can render the error", async () => {
    // `loaded` means "the boot read has finished", not "it succeeded". The
    // gate renders its loading shell while `!loaded`, and its error text only
    // after that early return — so leaving `loaded` false on failure turns a
    // registry error into a permanent "Loading accounts…" with the cause
    // visible only in a console warning.
    mockListAccounts.mockRejectedValueOnce(new Error("registry offline"))
    const store = makeStore()

    await expect(store.getState().load()).rejects.toThrow(/registry offline/)

    expect(store.getState().loaded).toBe(true)
  })

  it("lets a retry re-run the boot load after a failure", async () => {
    // `load()` early-returns when `loaded` is true. Settling on failure must
    // not make the failure permanent for the session.
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockRejectedValueOnce(new Error("registry offline"))
    const store = makeStore()
    await expect(store.getState().load()).rejects.toThrow(/registry offline/)

    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    await store.getState().load()

    expect(store.getState().accounts).toEqual([alpha])
    expect(store.getState().error).toBeNull()
  })
})

describe("browser Vault lifecycle", () => {
  beforeEach(() => {
    mockIsTauri = false
  })

  it("provisions the Vault before registering a browser account", async () => {
    const store = makeStore()

    await store
      .getState()
      .createAccount({ id: "acct_browser", displayName: "Browser", password: "secret" })

    expect(mockProvisionBrowserVault).toHaveBeenCalledWith("acct_browser", "secret")
    expect(mockCreateRegistryAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acct_browser" })
    )
    expect(store.getState().pendingRecoveryKey).toBe("recovery-key")
    expect(mockActivateAccountDatabase).toHaveBeenCalledWith("acct_browser", "web-standalone")
    expect(mockSetActiveRuntimeTargetContext).toHaveBeenCalledWith("acct_browser", "web-standalone")
  })

  it("unlocks and locks the browser Vault with the account gate", async () => {
    const browserAccount = account("acct_browser", "Browser")
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })
    const store = makeStore()
    await store.getState().load()

    await store.getState().unlockAccount(browserAccount.id, "secret")
    expect(mockUnlockBrowserVault).toHaveBeenCalledWith(browserAccount.id, "secret")
    expect(mockPrepareRuntimeTarget).toHaveBeenCalledWith(browserAccount.id)

    await store.getState().lock()
    expect(mockLockBrowserVault).toHaveBeenCalledTimes(1)
  })

  it("uses the Vault as browser password authority when the registry verifier has drifted", async () => {
    const browserAccount = account("acct_browser", "Browser")
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })
    mockVerifyPassword.mockResolvedValue(false)
    const store = makeStore()
    await store.getState().load()

    await store.getState().unlockAccount(browserAccount.id, "vault-password")

    expect(mockVerifyPassword).not.toHaveBeenCalled()
    expect(mockUnlockBrowserVault).toHaveBeenCalledWith(browserAccount.id, "vault-password")
  })

  it("rolls the registry verifier back when the Vault password update fails", async () => {
    const browserAccount = account("acct_browser", "Browser", verifier("old-password"))
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })
    mockChangeBrowserVaultPassword.mockRejectedValueOnce(new Error("vault write failed"))
    const store = makeStore()
    await store.getState().load()

    await expect(
      store.getState().changePassword(browserAccount.id, "old-password", "new-password")
    ).rejects.toThrow("vault write failed")

    expect(mockVerifyBrowserVaultPassword).toHaveBeenCalledWith(browserAccount.id, "old-password")
    expect(mockUpdatePasswordVerifier).toHaveBeenNthCalledWith(
      1,
      browserAccount.id,
      verifier("new-password")
    )
    expect(mockChangeBrowserVaultPassword).toHaveBeenCalledWith(
      browserAccount.id,
      "old-password",
      "new-password"
    )
    expect(mockUpdatePasswordVerifier).toHaveBeenNthCalledWith(
      2,
      browserAccount.id,
      browserAccount.passwordVerifier
    )
    expect(store.getState().accounts[0]).toEqual(browserAccount)
  })

  it("surfaces both failures when the Vault update and registry rollback fail", async () => {
    const browserAccount = account("acct_browser", "Browser", verifier("old-password"))
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })
    mockChangeBrowserVaultPassword.mockRejectedValueOnce(new Error("vault write failed"))
    mockUpdatePasswordVerifier
      .mockResolvedValueOnce(
        account(browserAccount.id, browserAccount.displayName, verifier("new-password"))
      )
      .mockRejectedValueOnce(new Error("registry rollback failed"))
    const store = makeStore()
    await store.getState().load()

    const rejection = store
      .getState()
      .changePassword(browserAccount.id, "old-password", "new-password")
    await expect(rejection).rejects.toBeInstanceOf(AggregateError)
    await expect(rejection).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "vault write failed" }),
        expect.objectContaining({ message: "registry rollback failed" }),
      ],
    })
  })

  it("clears a displayed one-time recovery key only after acknowledgement", async () => {
    const store = makeStore()
    await store
      .getState()
      .createAccount({ id: "acct_browser", displayName: "Browser", password: "secret" })

    store.getState().acknowledgeRecoveryKey()

    expect(store.getState().pendingRecoveryKey).toBeNull()
  })
})

// The leaf's own rules live in `lib/accounts/dev-session-unlock.test.ts`. What
// these pin is the wiring, which is the half this repo keeps shipping dormant:
// a remembered secret is worth nothing unless `load()` actually consults it,
// and worse than nothing if `lock()` does not erase it.
describe("development session unlock", () => {
  beforeEach(() => {
    mockIsTauri = false
  })

  it("re-opens the Vault on the next boot instead of asking again", async () => {
    const browserAccount = account("acct_browser", "Browser")
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })

    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount(browserAccount.id, "secret")

    // A reload is a brand new store over the same sessionStorage.
    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().unlockedAccountId).toBe(browserAccount.id)
    expect(reloaded.getState().locked).toBe(false)
    expect(mockUnlockBrowserVault).toHaveBeenLastCalledWith(browserAccount.id, "secret")
  })

  it("stays locked after an explicit lock, which is what makes the lock mean anything", async () => {
    const browserAccount = account("acct_browser", "Browser")
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })

    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount(browserAccount.id, "secret")
    await first.getState().lock()

    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().unlockedAccountId).toBeNull()
    expect(reloaded.getState().locked).toBe(true)
  })

  it("falls back to the gate when the remembered secret no longer opens the Vault", async () => {
    const browserAccount = account("acct_browser", "Browser")
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })

    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount(browserAccount.id, "secret")

    mockUnlockBrowserVault.mockRejectedValueOnce(new Error("wrong password"))
    const reloaded = makeStore()
    await expect(reloaded.getState().load()).resolves.toBeUndefined()

    expect(reloaded.getState().locked).toBe(true)
    // And the stale secret is gone, so the next boot does not retry it.
    const again = makeStore()
    await again.getState().load()
    expect(again.getState().locked).toBe(true)
  })

  it("never provisions a Vault, so first-run setup stays a deliberate choice", async () => {
    const browserAccount = account("acct_browser", "Browser")
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })

    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount(browserAccount.id, "secret")

    mockProvisionBrowserVault.mockClear()
    mockBrowserVaultExists.mockResolvedValue(false)
    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(mockProvisionBrowserVault).not.toHaveBeenCalled()
    expect(reloaded.getState().locked).toBe(true)
  })

  it("remembers the password typed during account creation", async () => {
    const store = makeStore()
    await store
      .getState()
      .createAccount({ id: "acct_browser", displayName: "Browser", password: "secret" })

    mockListAccounts.mockResolvedValue([account("acct_browser", "Browser")])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_browser" })
    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().unlockedAccountId).toBe("acct_browser")
  })

  it("does not resume on the desktop, where the password also binds the keyring", async () => {
    const browserAccount = account("acct_browser", "Browser")
    mockListAccounts.mockResolvedValue([browserAccount])
    mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })

    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount(browserAccount.id, "secret")

    mockIsTauri = true
    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().locked).toBe(true)
  })
})

describe("account store create and unlock", () => {
  it("creates the first account, migrates legacy data when present, and unlocks that database", async () => {
    mockLegacyDatabaseExists.mockResolvedValue(true)
    const store = makeStore()

    const created = await store
      .getState()
      .createAccount({ id: "acct_first", displayName: "First", password: "secret" })

    expect(mockCreatePasswordVerifier).toHaveBeenCalledWith("secret")
    expect(mockCreateRegistryAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acct_first",
        displayName: "First",
        activate: true,
      })
    )
    expect(mockMigrateLegacyDatabaseToAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAccountId: "acct_first",
      })
    )
    expect(created.id).toBe("acct_first")
    expect(store.getState().activeAccountId).toBe("acct_first")
    expect(store.getState().unlockedAccountId).toBe("acct_first")
    expect(store.getState().locked).toBe(false)
    expect(store.getState().accountRevision).toBe(1)
    expect(mockActivateAccountDatabase).toHaveBeenCalledWith("acct_first")
    expect(mockPrepareDatabase).toHaveBeenCalledTimes(1)
    expect(mockActivateAccountLocalState).toHaveBeenCalledWith("acct_first")
  })

  it("keeps a newly-created secondary account locked unless activation is requested", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "alpha-password")

    const beta = await store
      .getState()
      .createAccount({ id: "acct_beta", displayName: "Beta", password: "beta-password" })

    expect(beta.id).toBe("acct_beta")
    expect(mockMigrateLegacyDatabaseToAccount).not.toHaveBeenCalled()
    expect(store.getState().activeAccountId).toBe("acct_alpha")
    expect(store.getState().unlockedAccountId).toBe("acct_alpha")
    expect(mockActivateAccountDatabase).toHaveBeenLastCalledWith("acct_alpha")
  })

  it("verifies a password before unlocking and activating an existing account", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    await store.getState().unlockAccount("acct_alpha", "secret")

    expect(mockVerifyPassword).toHaveBeenCalledWith("secret", alpha.passwordVerifier, "acct_alpha")
    expect(mockSetActiveAccountId).toHaveBeenCalledWith("acct_alpha")
    expect(mockActivateAccountDatabase).toHaveBeenCalledWith("acct_alpha")
    expect(mockPrepareDatabase).toHaveBeenCalledTimes(1)
    expect(mockPrepareDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      mockActivateAccountLocalState.mock.invocationCallOrder[0]
    )
    expect(mockActivateAccountLocalState).toHaveBeenCalledWith("acct_alpha")
    expect(store.getState().unlockedAccountId).toBe("acct_alpha")
    expect(store.getState().locked).toBe(false)
  })

  it("can find an unloaded account from the registry before unlocking it", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    const store = makeStore()

    await store.getState().unlockAccount("acct_alpha", "secret")

    expect(mockListAccounts).toHaveBeenCalled()
    expect(store.getState().accounts).toEqual([alpha])
    expect(store.getState().unlockedAccountId).toBe("acct_alpha")
  })

  it("reports a missing account from the registry lookup", async () => {
    mockListAccounts.mockResolvedValue([])
    const store = makeStore()

    await expect(store.getState().unlockAccount("acct_missing", "secret")).rejects.toThrow(
      /Local account acct_missing does not exist/
    )

    expect(store.getState().error).toMatch(/acct_missing/)
  })

  it("rejects unlock when the password verifier fails", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockVerifyPassword.mockResolvedValue(false)
    const store = makeStore()
    await store.getState().load()

    await expect(store.getState().unlockAccount("acct_alpha", "wrong")).rejects.toThrow(
      /Invalid local account password/
    )

    expect(mockActivateAccountDatabase).not.toHaveBeenCalled()
    expect(store.getState().locked).toBe(true)
    expect(store.getState().error).toMatch(/Invalid local account password/)
  })

  it("normalizes string failures from account creation", async () => {
    mockCreatePasswordVerifier.mockRejectedValueOnce("weak password")
    const store = makeStore()

    await expect(
      store.getState().createAccount({ displayName: "Alpha", password: "secret" })
    ).rejects.toThrow(/weak password/)

    expect(store.getState().error).toBe("weak password")
  })
})

describe("account store avatar", () => {
  it("persists an avatar via the registry and mirrors it into state", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    const dataUrl = "data:image/png;base64,AAAA"
    const updated = await store.getState().setAccountAvatar("acct_alpha", dataUrl)

    expect(mockUpdateAvatarRegistry).toHaveBeenCalledWith("acct_alpha", dataUrl)
    expect(updated.avatarDataUrl).toBe(dataUrl)
    expect(store.getState().accounts.find((a) => a.id === "acct_alpha")?.avatarDataUrl).toBe(
      dataUrl
    )
    expect(store.getState().error).toBeNull()
  })

  it("clears the avatar when passed null", async () => {
    const alpha: LocalAccountRecord = {
      ...account("acct_alpha", "Alpha"),
      avatarDataUrl: "data:image/png;base64,AAAA",
    }
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockUpdateAvatarRegistry.mockImplementationOnce(async (id) => account(id, id))
    const store = makeStore()
    await store.getState().load()

    const updated = await store.getState().setAccountAvatar("acct_alpha", null)

    expect(mockUpdateAvatarRegistry).toHaveBeenCalledWith("acct_alpha", null)
    expect(updated.avatarDataUrl).toBeUndefined()
  })

  it("surfaces registry failures and records the error", async () => {
    mockUpdateAvatarRegistry.mockRejectedValueOnce(new Error("avatar write failed"))
    const store = makeStore()

    await expect(store.getState().setAccountAvatar("acct_alpha", "data:x")).rejects.toThrow(
      /avatar write failed/
    )
    expect(store.getState().error).toBe("avatar write failed")
  })
})

describe("account store switching, locking, and lifecycle", () => {
  it("switches accounts only after verifying the target password", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "alpha-password")

    await store.getState().switchAccount("acct_beta", "beta-password")

    expect(mockVerifyPassword).toHaveBeenLastCalledWith(
      "beta-password",
      beta.passwordVerifier,
      "acct_beta"
    )
    expect(mockClearSubscriptionRuntime).toHaveBeenCalledWith("acct_alpha")
    expect(mockTeardownPluginRuntime).toHaveBeenCalledWith("acct_alpha")
    expect(mockTeardownPluginRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetActiveAccountId.mock.invocationCallOrder.at(-1)!
    )
    expect(mockClearSubscriptionRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetActiveAccountId.mock.invocationCallOrder.at(-1)!
    )
    expect(mockSetActiveAccountId).toHaveBeenLastCalledWith("acct_beta")
    expect(mockActivateAccountDatabase).toHaveBeenLastCalledWith("acct_beta")
    expect(mockActivateAccountLocalState).toHaveBeenLastCalledWith("acct_beta")
    expect(store.getState().activeAccountId).toBe("acct_beta")
    expect(store.getState().unlockedAccountId).toBe("acct_beta")
    expect(store.getState().accountRevision).toBe(3)
  })

  it("keeps the current account selected but locked when plugin teardown blocks a switch", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "alpha-password")
    mockTeardownPluginRuntime.mockRejectedValueOnce(new Error("plugin runtime still active"))

    await expect(store.getState().switchAccount("acct_beta", "beta-password")).rejects.toThrow(
      /plugin runtime still active/
    )

    expect(mockSetActiveAccountId).not.toHaveBeenCalledWith("acct_beta")
    expect(store.getState().activeAccountId).toBe("acct_alpha")
    expect(store.getState().unlockedAccountId).toBeNull()
  })

  it("re-activates the current unlocked account without password verification", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")
    mockVerifyPassword.mockClear()

    await store.getState().switchAccount("acct_alpha")

    expect(mockVerifyPassword).not.toHaveBeenCalled()
    expect(mockSetActiveAccountId).toHaveBeenLastCalledWith("acct_alpha")
  })

  it("rejects switching when the target password verifier fails", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "alpha-password")
    mockVerifyPassword.mockResolvedValueOnce(false)

    await expect(store.getState().switchAccount("acct_beta", "wrong")).rejects.toThrow(
      /Invalid local account password/
    )

    expect(store.getState().activeAccountId).toBe("acct_alpha")
  })

  it("requires a password when switching to a locked account", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    await expect(store.getState().switchAccount("acct_beta")).rejects.toThrow(
      /Local account password is required/
    )

    expect(mockSetActiveAccountId).not.toHaveBeenCalled()
    expect(mockActivateAccountDatabase).not.toHaveBeenCalled()
  })

  it("clears the active database selection when locked", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")

    await store.getState().lock()

    expect(mockTeardownPluginRuntime).toHaveBeenCalledWith("acct_alpha")
    expect(mockBumpPerformanceSecurityGeneration).toHaveBeenCalledWith(
      "acct_alpha",
      "account-locked"
    )
    expect(mockClearSubscriptionRuntime).toHaveBeenCalledWith("acct_alpha")
    expect(mockClearAccountDatabaseSelection).toHaveBeenCalled()
    expect(mockClearAccountLocalState).toHaveBeenCalled()
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().locked).toBe(true)
  })

  // Replaces an earlier test that pinned the opposite contract ("keeps the local
  // account unlocked when runtime clearing fails"). A lock must not fail open:
  // that path aborted before `set(...)`, so the Browser Vault could already be
  // locked and the host binding already dropped while the UI still showed the
  // workspace as unlocked. Locking is a security action — a partial teardown is
  // reported, never rolled back.
  it("still locks when a teardown step fails, and reports the failure", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")
    mockClearSubscriptionRuntime.mockRejectedValueOnce(new Error("runtime clear failed"))

    await expect(store.getState().lock()).rejects.toThrow(/runtime clear failed/)

    expect(mockClearAccountDatabaseSelection).toHaveBeenCalled()
    expect(mockClearAccountLocalState).toHaveBeenCalled()
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().locked).toBe(true)
  })

  it("aggregates several teardown failures instead of hiding all but the first", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")
    mockStopRuntimeSubscriptions.mockRejectedValueOnce(new Error("subscriptions still live"))
    mockClearSubscriptionRuntime.mockRejectedValueOnce(new Error("runtime clear failed"))

    await expect(store.getState().lock()).rejects.toThrow(/teardown was incomplete/i)

    expect(store.getState().locked).toBe(true)
  })

  it("releases live runtime subscriptions before the database selection is cleared", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")

    await store.getState().lock()

    // Order is the whole point: `getDb()` falls back to the legacy database name
    // once the selection is gone, so a subscriber that is still live at that
    // moment silently re-opens and writes to the wrong database.
    expect(mockStopRuntimeSubscriptions).toHaveBeenCalled()
    const stoppedAt = mockStopRuntimeSubscriptions.mock.invocationCallOrder[0]!
    const clearedAt = mockClearAccountDatabaseSelection.mock.invocationCallOrder[0]!
    expect(stoppedAt).toBeLessThan(clearedAt)
  })

  it("renames accounts in registry and local state", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    const renamed = await store.getState().renameAccount("acct_alpha", "Renamed")

    expect(mockRenameRegistryAccount).toHaveBeenCalledWith("acct_alpha", "Renamed")
    expect(renamed.displayName).toBe("Renamed")
    expect(store.getState().accounts[0].displayName).toBe("Renamed")
  })

  it("records rename failures without mutating the local account list", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockRenameRegistryAccount.mockRejectedValueOnce(new Error("rename failed"))
    const store = makeStore()
    await store.getState().load()

    await expect(store.getState().renameAccount("acct_alpha", "Broken")).rejects.toThrow(
      /rename failed/
    )

    expect(store.getState().accounts[0].displayName).toBe("Alpha")
    expect(store.getState().error).toBe("rename failed")
  })

  it("changes a desktop password through the native re-authentication transaction", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "old-password")

    const updated = await store
      .getState()
      .changePassword("acct_alpha", "old-password", "new-secret")

    expect(mockRotateNativePassword).toHaveBeenCalledWith(
      "acct_alpha",
      "old-password",
      alpha.passwordVerifier,
      "new-secret"
    )
    expect(mockUpdatePasswordVerifier).toHaveBeenCalledWith("acct_alpha", verifier("new-secret"))
    expect(updated.passwordVerifier).toEqual(verifier("new-secret"))
    expect(store.getState().accounts[0].passwordVerifier).toEqual(verifier("new-secret"))
    expect(store.getState().error).toBeNull()
  })

  // Capacitor is `!shouldUseBrowserVault()` too, but there is no native
  // rotation command there — routing it down the desktop branch made
  // `rotateNativePassword` throw "only available in the desktop runtime"
  // before anything committed, so mobile users could not change a password
  // at all.
  it("changes a mobile password without the desktop-only native rotation", async () => {
    mockIsTauri = false
    mockIsCapacitor = true
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "old-password")

    const updated = await store
      .getState()
      .changePassword("acct_alpha", "old-password", "new-secret")

    expect(mockRotateNativePassword).not.toHaveBeenCalled()
    expect(mockVerifyPassword).toHaveBeenCalledWith(
      "old-password",
      alpha.passwordVerifier,
      "acct_alpha"
    )
    expect(mockChangeBrowserVaultPassword).toHaveBeenCalledWith(
      "acct_alpha",
      "old-password",
      "new-secret"
    )
    expect(mockUpdatePasswordVerifier).toHaveBeenCalledWith("acct_alpha", verifier("new-secret"))
    expect(updated.passwordVerifier).toEqual(verifier("new-secret"))
  })

  it("re-pins the host binding when the password rotates", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "old-password")

    await store.getState().changePassword("acct_alpha", "old-password", "new-secret")

    // Without this the host stays pinned to the OLD verifier and refuses every
    // later unlock as a binding mismatch.
    expect(mockRotateNativePassword).toHaveBeenCalledWith(
      "acct_alpha",
      "old-password",
      alpha.passwordVerifier,
      "new-secret"
    )
  })

  it("rolls the native verifier pin back when the registry commit fails", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockUpdatePasswordVerifier.mockRejectedValueOnce(new Error("registry write failed"))
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "old-password")

    await expect(
      store.getState().changePassword("acct_alpha", "old-password", "new-secret")
    ).rejects.toThrow("registry write failed")

    expect(mockRotateNativePassword).toHaveBeenNthCalledWith(
      2,
      "acct_alpha",
      "new-secret",
      verifier("new-secret"),
      "old-password",
      alpha.passwordVerifier
    )
  })

  it("drops the host account binding when locking", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")

    await store.getState().lock()

    expect(mockUnbindLocalAccount).toHaveBeenCalled()
    expect(store.getState().unlockedAccountId).toBeNull()
  })

  it("rejects a password change when the current password is wrong", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockRotateNativePassword.mockRejectedValueOnce(new Error("Invalid local account password."))
    const store = makeStore()
    await store.getState().load()

    await expect(
      store.getState().changePassword("acct_alpha", "wrong", "new-secret")
    ).rejects.toThrow(/Invalid local account password/)

    expect(mockRotateNativePassword).toHaveBeenCalled()
    expect(mockUpdatePasswordVerifier).not.toHaveBeenCalled()
    expect(store.getState().error).toMatch(/Invalid local account password/)
  })

  it("requires both the current and the new password to change a password", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    await expect(store.getState().changePassword("acct_alpha", "old", "  ")).rejects.toThrow(
      /Local account password is required/
    )

    expect(mockVerifyPassword).not.toHaveBeenCalled()
    expect(mockUpdatePasswordVerifier).not.toHaveBeenCalled()
  })

  it("deletes an inactive account with database and local-state cascade", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")

    const result = await store.getState().deleteAccount("acct_beta")

    expect(mockDeleteRegistryAccount).toHaveBeenCalledWith("acct_beta", {
      replacementAccountId: undefined,
    })
    expect(mockDropAccountDatabase).toHaveBeenCalledWith("acct_beta")
    expect(mockPurgeAccountLocalState).toHaveBeenCalledWith("acct_beta")
    expect(store.getState().accounts.map((item) => item.id)).toEqual(["acct_alpha"])
    expect(store.getState().unlockedAccountId).toBe("acct_alpha")
    expect(result).toMatchObject({
      accountId: "acct_beta",
      wasActive: false,
      registryDeleted: true,
      accountDatabaseDeleted: true,
      localStatePurged: true,
    })
  })

  it("records delete failures before local cascade runs", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockDeleteRegistryAccount.mockRejectedValueOnce(new Error("delete failed"))
    const store = makeStore()
    await store.getState().load()

    await expect(store.getState().deleteAccount("acct_beta")).rejects.toThrow(/delete failed/)

    expect(mockDropAccountDatabase).not.toHaveBeenCalled()
    expect(store.getState().accounts.map((item) => item.id)).toEqual(["acct_alpha", "acct_beta"])
  })

  it("deleting the active account moves the active pointer to the replacement and locks", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")

    const result = await store
      .getState()
      .deleteAccount("acct_alpha", { replacementAccountId: "acct_beta" })

    expect(mockDeleteRegistryAccount).toHaveBeenCalledWith("acct_alpha", {
      replacementAccountId: "acct_beta",
    })
    expect(mockClearAccountDatabaseSelection).toHaveBeenCalled()
    expect(mockClearAccountLocalState).toHaveBeenCalled()
    expect(store.getState().activeAccountId).toBe("acct_beta")
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().locked).toBe(true)
    expect(result.wasActive).toBe(true)
  })

  it("uses default account-local storage helpers when no dependency override is supplied", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = createAccountStore({ dropAccountDatabase: mockDropAccountDatabase })
    window.localStorage.setItem("cognia-account-acct_beta:panel", "1")
    window.localStorage.setItem("cognia-artifacts:acct_beta:item", "2")
    window.localStorage.setItem("cognia-agent-teams:acct_beta:item", "3")
    window.localStorage.setItem("cognia-account-acct_alpha:panel", "keep")

    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")
    await store.getState().deleteAccount("acct_beta")
    await store.getState().lock()

    expect(mockDropAccountDatabase).toHaveBeenCalledWith("acct_beta")
    expect(window.localStorage.getItem("cognia-account-acct_beta:panel")).toBeNull()
    expect(window.localStorage.getItem("cognia-artifacts:acct_beta:item")).toBeNull()
    expect(window.localStorage.getItem("cognia-agent-teams:acct_beta:item")).toBeNull()
    expect(window.localStorage.getItem("cognia-account-acct_alpha:panel")).toBe("keep")
  })
})

describe("account store unlock progress and recovery", () => {
  const stages = (): string[] => {
    const seen: string[] = []
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ stage: string }>).detail.stage)
    }
    window.addEventListener("cognia:account-unlock-progress", listener)
    recorded.push(() => window.removeEventListener("cognia:account-unlock-progress", listener))
    return seen
  }
  const recorded: Array<() => void> = []
  afterEach(() => {
    while (recorded.length) recorded.pop()!()
  })

  it("announces every stage of a desktop unlock, without the browser-only step", async () => {
    mockIsTauri = true
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    const seen = stages()

    await store.getState().unlockAccount("acct_alpha", "secret")

    expect(seen).toEqual(["verifying", "opening-database", "activating", "ready"])
  })

  it("announces the runtime-target step on a Browser Vault unlock", async () => {
    mockIsTauri = false
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    const seen = stages()

    await store.getState().unlockAccount("acct_alpha", "secret")

    expect(seen).toEqual([
      "verifying",
      "preparing-runtime",
      "opening-database",
      "activating",
      "ready",
    ])
  })

  it("announces failure so the lock screen leaves its pending state", async () => {
    mockIsTauri = true
    mockVerifyPassword.mockResolvedValue(false)
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    const seen = stages()

    await expect(store.getState().unlockAccount("acct_alpha", "nope")).rejects.toMatchObject({
      code: "invalid-password",
    })

    expect(seen).toEqual(["verifying", "failed"])
  })

  it("types an empty password so the screen can translate it", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    await expect(store.getState().unlockAccount("acct_alpha", "  ")).rejects.toMatchObject({
      code: "password-required",
    })
  })

  it("redeems a recovery key, rotates the verifier, and unlocks", async () => {
    mockIsTauri = false
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    await store.getState().unlockAccountWithRecoveryKey("acct_alpha", " key-abc ", "brand new pw")

    expect(mockResetVaultWithRecoveryKey).toHaveBeenCalledWith(
      "acct_alpha",
      "key-abc",
      "brand new pw"
    )
    // Rotating the vault wrap alone is not enough: the registry verifier is what
    // the desktop host and the change-password flow compare against.
    expect(mockCreatePasswordVerifier).toHaveBeenCalledWith("brand new pw")
    expect(mockUpdatePasswordVerifier).toHaveBeenCalledWith(
      "acct_alpha",
      expect.objectContaining({ algorithm: expect.any(String) })
    )
    expect(store.getState().locked).toBe(false)
    expect(store.getState().unlockedAccountId).toBe("acct_alpha")
  })

  it("refuses a recovery unlock on the desktop host, which mints no recovery key", async () => {
    mockIsTauri = true
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    await expect(
      store.getState().unlockAccountWithRecoveryKey("acct_alpha", "key-abc", "brand new pw")
    ).rejects.toMatchObject({ code: "vault-not-provisioned" })
    expect(mockResetVaultWithRecoveryKey).not.toHaveBeenCalled()
  })

  it("requires both a recovery key and a replacement password", async () => {
    mockIsTauri = false
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    await expect(
      store.getState().unlockAccountWithRecoveryKey("acct_alpha", "  ", "brand new pw")
    ).rejects.toMatchObject({ code: "invalid-recovery-key" })
    await expect(
      store.getState().unlockAccountWithRecoveryKey("acct_alpha", "key-abc", " ")
    ).rejects.toMatchObject({ code: "password-required" })
    expect(mockResetVaultWithRecoveryKey).not.toHaveBeenCalled()
  })

  it("leaves the account locked when the recovery key is refused", async () => {
    mockIsTauri = false
    mockResetVaultWithRecoveryKey.mockRejectedValueOnce(
      new Error("Vault recovery key is malformed.")
    )
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()

    await expect(
      store.getState().unlockAccountWithRecoveryKey("acct_alpha", "wrong", "brand new pw")
    ).rejects.toMatchObject({ code: "invalid-recovery-key" })
    expect(mockUpdatePasswordVerifier).not.toHaveBeenCalled()
    expect(store.getState().locked).toBe(true)
  })
})

describe("deleteAccount cascades through the profile's cloud identity (ADR-0149)", () => {
  it("forgets the cloud identity of an inactive profile without touching the host", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")

    const result = await store.getState().deleteAccount("acct_beta")

    expect(mockForgetCloudIdentity).toHaveBeenCalledWith("acct_beta", { hostBound: false })
    expect(result.cloudIdentity.localAccountId).toBe("acct_beta")
    expect(result.cloudIdentity.failures).toEqual([])
  })

  it("forgets the unlocked profile's identity BEFORE locking, while the host still holds it", async () => {
    // `lock()` unbinds the host namespace; after that the host can no longer
    // be told whose person to forget. The order is the whole point.
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const order: string[] = []
    mockForgetCloudIdentity.mockImplementation(async (localAccountId) => {
      order.push("forget-cloud-identity")
      return cleanCloudIdentity(localAccountId)
    })
    mockUnbindLocalAccount.mockImplementation(async () => {
      order.push("unbind-local-account")
    })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "secret")
    order.length = 0

    await store.getState().deleteAccount("acct_alpha", { replacementAccountId: "acct_beta" })

    expect(mockForgetCloudIdentity).toHaveBeenCalledWith("acct_alpha", { hostBound: true })
    expect(order.indexOf("forget-cloud-identity")).toBeLessThan(
      order.indexOf("unbind-local-account")
    )
  })

  it("does not reach the cloud identity when the registry refuses the delete", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockDeleteRegistryAccount.mockRejectedValueOnce(new Error("last account"))
    const store = makeStore()
    await store.getState().load()

    await expect(store.getState().deleteAccount("acct_beta")).rejects.toThrow(/last account/)
    expect(mockForgetCloudIdentity).not.toHaveBeenCalled()
  })

  it("reports a partial cloud cleanup on the result instead of failing the delete", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockForgetCloudIdentity.mockResolvedValue({
      ...cleanCloudIdentity("acct_beta"),
      steps: {
        ...cleanCloudIdentity("acct_beta").steps,
        session: { status: "failed", error: "keyring" },
      },
      failures: [{ step: "session", error: "keyring" }],
      tokensMayRemainLive: true,
    })
    const store = makeStore()
    await store.getState().load()

    const result = await store.getState().deleteAccount("acct_beta")

    expect(result.cloudIdentity.tokensMayRemainLive).toBe(true)
    expect(result.cloudIdentity.failures).toEqual([{ step: "session", error: "keyring" }])
    expect(mockDropAccountDatabase).toHaveBeenCalledWith("acct_beta")
    expect(store.getState().accounts.map((item) => item.id)).toEqual(["acct_alpha"])
  })

  it("the default dependency calls the identity module with the host flag", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = createAccountStore({
      dropAccountDatabase: mockDropAccountDatabase,
      purgeAccountLocalState: mockPurgeAccountLocalState,
      removeRuntimeTargets: mockRemoveRuntimeTargets,
    })
    await store.getState().load()

    await store.getState().deleteAccount("acct_beta")

    expect(mockForgetProfileCloudIdentity).toHaveBeenCalledWith("acct_beta", { hostBound: false })
  })
})
