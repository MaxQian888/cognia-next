/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"

import type { ProfileCloudIdentityCleanup } from "@/lib/identity/forget-profile-identity"

import type { AccountStoreDependencies } from "./account-store"

let mockDesktopLocalEnabled = false
const mockDesktopLocalPassword = jest.fn<Promise<string | null>, [boolean?]>()
const mockSaveDesktopRecovery = jest.fn<Promise<void>, [string]>()
const mockReadDesktopRecovery = jest.fn<Promise<string | null>, []>()
const mockClearDesktopRecovery = jest.fn<Promise<void>, []>()
const mockClearDesktopLocalPassword = jest.fn<Promise<void>, []>()
const mockReadDeviceUnlockSecret = jest.fn<Promise<string | null>, [string]>()
const mockSaveDeviceUnlockSecret = jest.fn<Promise<void>, [string, string]>()
const mockClearDeviceUnlockSecret = jest.fn<Promise<void>, [string]>()
jest.mock("@/lib/accounts/desktop-local-account", () => ({
  DESKTOP_LOCAL_ACCOUNT_ID: "acct_desktop_local_workspace",
  isDesktopLocalAccountEnabled: () => mockDesktopLocalEnabled,
  isDeviceUnlockSupported: () => mockDesktopLocalEnabled,
  isDeviceManagedAccount: (record: LocalAccountRecord | null | undefined) =>
    record?.id === "acct_desktop_local_workspace" && record.protection === "device",
  isRememberedOnDevice: (record: LocalAccountRecord | null | undefined) =>
    !!record && record.protection !== "device" && record.rememberOnDevice === true,
  readDeviceUnlockSecret: (id: string) => mockReadDeviceUnlockSecret(id),
  saveDeviceUnlockSecret: (id: string, secret: string) => mockSaveDeviceUnlockSecret(id, secret),
  clearDeviceUnlockSecret: (id: string) => mockClearDeviceUnlockSecret(id),
  desktopLocalAccountPassword: (...args: [boolean?]) => mockDesktopLocalPassword(...args),
  clearDesktopLocalAccountPassword: () => mockClearDesktopLocalPassword(),
  saveDesktopLocalAccountRecoveryKey: (key: string) => mockSaveDesktopRecovery(key),
  readDesktopLocalAccountRecoveryKey: () => mockReadDesktopRecovery(),
  clearDesktopLocalAccountRecoveryKey: () => mockClearDesktopRecovery(),
}))

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
const mockUpdateRememberOnDevice = jest.fn<Promise<LocalAccountRecord>, [string, boolean]>()

jest.mock("@/lib/accounts/account-db", () => ({
  LocalAccountRegistry: jest.fn().mockImplementation(() => ({
    listAccounts: mockListAccounts,
    getState: mockGetState,
    createAccount: mockCreateRegistryAccount,
    renameAccount: mockRenameRegistryAccount,
    updatePasswordVerifier: mockUpdatePasswordVerifier,
    updateAvatar: mockUpdateAvatarRegistry,
    updateRememberOnDevice: mockUpdateRememberOnDevice,
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
let dropDexieAccountDatabase: typeof import("./account-store").dropDexieAccountDatabase

beforeAll(async () => {
  const mod = await import("./account-store")
  createAccountStore = mod.createAccountStore
  selectActiveAccount = mod.selectActiveAccount
  dropDexieAccountDatabase = mod.dropDexieAccountDatabase
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
  mockDesktopLocalEnabled = false
  mockSaveDesktopRecovery.mockResolvedValue()
  mockReadDesktopRecovery.mockResolvedValue("preserved-recovery-key")
  mockClearDesktopRecovery.mockResolvedValue()
  mockDesktopLocalPassword.mockResolvedValue("device-random-secret")
  mockClearDesktopLocalPassword.mockResolvedValue()
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
  mockUpdateRememberOnDevice.mockImplementation(async (id, enabled) => ({
    ...account(id, id),
    ...(enabled ? { rememberOnDevice: true } : {}),
  }))
  mockReadDeviceUnlockSecret.mockResolvedValue(null)
  mockSaveDeviceUnlockSecret.mockResolvedValue()
  mockClearDeviceUnlockSecret.mockResolvedValue()
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

// The predicate's own rules live in `lib/accounts/dev-auto-unlock.test.ts`.
// What matters here is that `load()` actually reaches the app without a
// prompt, and that it never does so for an account the developer made.
describe("development local account", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  function setNodeEnv(value: string | undefined): void {
    Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true })
  }

  beforeEach(() => {
    mockIsTauri = false
    mockIsCapacitor = false
    setNodeEnv("development")
  })

  afterEach(() => {
    setNodeEnv(ORIGINAL_NODE_ENV)
  })

  it("provisions and unlocks the disposable account when the registry is empty", async () => {
    const store = makeStore()

    await store.getState().load()

    expect(mockCreateRegistryAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acct_dev_local_workspace", activate: true })
    )
    expect(mockProvisionBrowserVault).toHaveBeenCalledWith(
      "acct_dev_local_workspace",
      "cognia-dev-local-account"
    )
    expect(store.getState().unlockedAccountId).toBe("acct_dev_local_workspace")
    expect(store.getState().activeAccountId).toBe("acct_dev_local_workspace")
    expect(store.getState().locked).toBe(false)
    expect(store.getState().loaded).toBe(true)
  })

  it("adopts the account a racing tab created instead of standing a second one up", async () => {
    // Both tabs read an empty registry, so both would provision. The loser's
    // `provisionBrowserVault` REPLACES the winner's vault record and its
    // rollback then deletes it, leaving the winner signed in against a vault
    // that no longer exists. Re-reading inside the provisioning lock is what
    // turns the loser into an ordinary unlock.
    const dev = account("acct_dev_local_workspace", "Developer")
    mockListAccounts.mockResolvedValueOnce([]).mockResolvedValue([dev])
    const store = makeStore()

    await store.getState().load()

    expect(mockCreateRegistryAccount).not.toHaveBeenCalled()
    expect(mockProvisionBrowserVault).not.toHaveBeenCalled()
    expect(mockUnlockBrowserVault).toHaveBeenCalledWith(
      "acct_dev_local_workspace",
      "cognia-dev-local-account"
    )
    expect(store.getState().unlockedAccountId).toBe("acct_dev_local_workspace")
    expect(store.getState().locked).toBe(false)
  })

  it("swallows the recovery key so first-run setup has nothing left to show", async () => {
    // The key wraps a throwaway database whose password is a constant in the
    // bundle. Surfacing it would put the acknowledge screen back in front of
    // every new browser, which is the cost this account exists to remove.
    const store = makeStore()

    await store.getState().load()

    expect(store.getState().pendingRecoveryKey).toBeNull()
  })

  it("re-opens the disposable account in a new tab, with nothing remembered", async () => {
    // `resumeTabSessionUnlock` reads sessionStorage, which dies with the tab.
    // The constant password is what makes a second window free.
    const dev = account("acct_dev_local_workspace", "Developer")
    mockListAccounts.mockResolvedValue([dev])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_dev_local_workspace" })
    const store = makeStore()

    await store.getState().load()

    expect(mockCreateRegistryAccount).not.toHaveBeenCalled()
    expect(mockUnlockBrowserVault).toHaveBeenCalledWith(
      "acct_dev_local_workspace",
      "cognia-dev-local-account"
    )
    expect(store.getState().unlockedAccountId).toBe("acct_dev_local_workspace")
    expect(store.getState().locked).toBe(false)
  })

  it("leaves an account the developer created behind its real password", async () => {
    const mine = account("acct_mine", "Mine")
    mockListAccounts.mockResolvedValue([mine])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_mine" })
    const store = makeStore()

    await store.getState().load()

    expect(mockCreateRegistryAccount).not.toHaveBeenCalled()
    expect(mockUnlockBrowserVault).not.toHaveBeenCalled()
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().locked).toBe(true)
  })

  it("does nothing under Tauri, where the password binds the OS keyring", async () => {
    mockIsTauri = true
    const store = makeStore()

    await store.getState().load()

    expect(mockCreateRegistryAccount).not.toHaveBeenCalled()
    expect(store.getState().unlockedAccountId).toBeNull()
  })

  it("does nothing in a shipped build", async () => {
    setNodeEnv("production")
    const store = makeStore()

    await store.getState().load()

    expect(mockCreateRegistryAccount).not.toHaveBeenCalled()
    expect(store.getState().unlockedAccountId).toBeNull()
  })

  it("falls back to first-run setup when provisioning fails, with no error banner", async () => {
    // Convenience must never be able to make a boot worse than the gate it
    // replaced: a failed provision has to settle as an ordinary empty registry.
    mockCreateRegistryAccount.mockRejectedValueOnce(new Error("registry offline"))
    const store = makeStore()

    await store.getState().load()

    expect(store.getState().loaded).toBe(true)
    expect(store.getState().accounts).toEqual([])
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().error).toBeNull()
  })

  it("falls back to the lock screen when the constant password stops opening the vault", async () => {
    const dev = account("acct_dev_local_workspace", "Developer")
    mockListAccounts.mockResolvedValue([dev])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_dev_local_workspace" })
    mockUnlockBrowserVault.mockRejectedValueOnce(new Error("bad password"))
    const store = makeStore()

    await store.getState().load()

    expect(store.getState().loaded).toBe(true)
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().locked).toBe(true)
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

// The leaf's own rules live in `lib/accounts/tab-session-unlock.test.ts`. What
// these pin is the wiring, which is the half this repo keeps shipping dormant:
// a remembered secret is worth nothing unless `load()` actually consults it,
// and worse than nothing if `lock()` does not erase it.
describe("browser tab session unlock", () => {
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

  it("does not resume in a production browser build, which never keeps the password", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true })
    try {
      const browserAccount = account("acct_browser", "Browser")
      mockListAccounts.mockResolvedValue([browserAccount])
      mockGetState.mockResolvedValue({ activeAccountId: browserAccount.id })

      const first = makeStore()
      await first.getState().load()
      await first.getState().unlockAccount(browserAccount.id, "secret")

      const reloaded = makeStore()
      await reloaded.getState().load()

      expect(reloaded.getState().unlockedAccountId).toBeNull()
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: originalNodeEnv,
        configurable: true,
      })
    }
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

describe("dropDexieAccountDatabase", () => {
  async function createDatabase(name: string): Promise<void> {
    const { default: Dexie } = await import("dexie")
    const db = new Dexie(name)
    db.version(1).stores({ rows: "&id" })
    await db.open()
    db.close()
  }

  it("deletes the account databases and the Router + Fusion ledger beside the encrypted one", async () => {
    const { default: Dexie } = await import("dexie")
    const names = [
      "cognia-account-acct_drop",
      "cognia-account-acct_drop-encrypted-v1",
      "cognia-account-acct_drop-encrypted-v1-router-fusion-v1",
    ]
    for (const name of names) await createDatabase(name)

    await dropDexieAccountDatabase("acct_drop")

    for (const name of names) expect(await Dexie.exists(name)).toBe(false)
  })

  it("[ACC:OFF-03] succeeds for an account that never switched Router + Fusion on", async () => {
    const { default: Dexie } = await import("dexie")
    await createDatabase("cognia-account-acct_plain-encrypted-v1")

    await expect(dropDexieAccountDatabase("acct_plain")).resolves.toBeUndefined()

    expect(await Dexie.exists("cognia-account-acct_plain-encrypted-v1")).toBe(false)
    expect(await Dexie.exists("cognia-account-acct_plain-encrypted-v1-router-fusion-v1")).toBe(
      false
    )
  })
})

describe("device-managed desktop workspace", () => {
  const id = "acct_desktop_local_workspace"
  const deviceAccount = (): LocalAccountRecord => ({
    ...account(id, "Local"),
    protection: "device",
  })

  it("provisions fresh desktop using the persisted native secret and no recovery gate", async () => {
    mockDesktopLocalEnabled = true
    mockBrowserVaultExists.mockResolvedValue(false)
    let records: LocalAccountRecord[] = []
    mockListAccounts.mockImplementation(async () => records)
    mockGetState.mockImplementation(async () => ({ activeAccountId: records[0]?.id ?? null }))
    mockCreateRegistryAccount.mockImplementation(async () => {
      const created = deviceAccount()
      records = [created]
      return created
    })
    const store = makeStore()
    await store.getState().load()
    expect(mockSaveDesktopRecovery).toHaveBeenCalledWith("recovery-key")
    expect(mockDesktopLocalPassword).toHaveBeenCalledWith(true)
    expect(mockProvisionBrowserVault).toHaveBeenCalledWith(id, "device-random-secret")
    expect(mockVerifyPassword).toHaveBeenCalledWith("device-random-secret", expect.anything(), id)
    expect(store.getState()).toMatchObject({
      unlockedAccountId: id,
      locked: false,
      pendingRecoveryKey: null,
    })
  })

  it("reopens only the existing device profile through native verification", async () => {
    mockDesktopLocalEnabled = true
    mockListAccounts.mockResolvedValue([deviceAccount()])
    mockGetState.mockResolvedValue({ activeAccountId: id })
    const store = makeStore()
    await store.getState().load()
    expect(mockDesktopLocalPassword).not.toHaveBeenCalledWith(true)
    expect(mockUnlockBrowserVault).toHaveBeenCalledWith(id, "device-random-secret")
    expect(mockProvisionBrowserVault).not.toHaveBeenCalled()
    expect(store.getState().locked).toBe(false)
  })

  it("keeps explicit password profiles locked", async () => {
    mockDesktopLocalEnabled = true
    mockListAccounts.mockResolvedValue([{ ...deviceAccount(), protection: "password" }])
    mockGetState.mockResolvedValue({ activeAccountId: id })
    const store = makeStore()
    await store.getState().load()
    expect(store.getState().locked).toBe(true)
    expect(mockDesktopLocalPassword).not.toHaveBeenCalled()
  })

  it("fails closed when an existing native secret is missing", async () => {
    mockDesktopLocalEnabled = true
    mockListAccounts.mockResolvedValue([deviceAccount()])
    mockGetState.mockResolvedValue({ activeAccountId: id })
    mockDesktopLocalPassword.mockResolvedValue(null)
    const store = makeStore()
    // Named for what happened, not "password required": nobody typed one.
    await expect(store.getState().load()).rejects.toThrow("device credential is missing")
    expect(store.getState()).toMatchObject({ loaded: true, locked: true })
    expect(mockProvisionBrowserVault).not.toHaveBeenCalled()
    expect(mockCreateRegistryAccount).not.toHaveBeenCalled()
  })

  it("does not replace a vault whose registry entry was lost", async () => {
    mockDesktopLocalEnabled = true
    const store = makeStore()
    await expect(store.getState().load()).rejects.toThrow("registry is missing")
    expect(mockDesktopLocalPassword).not.toHaveBeenCalled()
    expect(mockProvisionBrowserVault).not.toHaveBeenCalled()
  })

  it("does not regenerate a missing vault during resume", async () => {
    mockDesktopLocalEnabled = true
    mockListAccounts.mockResolvedValue([deviceAccount()])
    mockGetState.mockResolvedValue({ activeAccountId: id })
    mockBrowserVaultExists.mockResolvedValue(false)
    const store = makeStore()
    await expect(store.getState().load()).rejects.toThrow("vault is missing")
    expect(mockProvisionBrowserVault).not.toHaveBeenCalled()
  })

  it("promotes an unlocked device workspace to password protection", async () => {
    const store = makeStore()
    store.setState({ accounts: [deviceAccount()], activeAccountId: id, unlockedAccountId: id })
    mockUpdatePasswordVerifier.mockResolvedValue({ ...deviceAccount(), protection: "password" })
    await store.getState().changePassword(id, "", "user-new-password")
    expect(mockRotateNativePassword).toHaveBeenCalledWith(
      id,
      "device-random-secret",
      expect.anything(),
      "user-new-password"
    )
    expect(mockUpdatePasswordVerifier).toHaveBeenCalledWith(
      id,
      expect.anything(),
      undefined,
      "password"
    )
    expect(store.getState().pendingRecoveryKey).toBe("preserved-recovery-key")
    expect(mockClearDesktopRecovery).not.toHaveBeenCalled()
    expect(mockClearDesktopLocalPassword).toHaveBeenCalled()
    expect(store.getState().accounts[0]?.protection).toBe("password")
  })

  it("reports the promotion as done even when the old device secret cannot be cleared", async () => {
    const store = makeStore()
    store.setState({ accounts: [deviceAccount()], activeAccountId: id, unlockedAccountId: id })
    mockUpdatePasswordVerifier.mockResolvedValue({ ...deviceAccount(), protection: "password" })
    mockClearDesktopLocalPassword.mockRejectedValueOnce(new Error("SECRET_STORE_LOCKED: denied"))
    await expect(
      store.getState().changePassword(id, "", "user-new-password")
    ).resolves.toMatchObject({ protection: "password" })
    expect(store.getState().error).toBeNull()
    expect(store.getState().accounts[0]?.protection).toBe("password")
  })

  it("cannot set a device workspace password from a locked session", async () => {
    const store = makeStore()
    store.setState({ accounts: [deviceAccount()], activeAccountId: id, unlockedAccountId: null })
    await expect(store.getState().changePassword(id, "", "user-new-password")).rejects.toThrow(
      "Unlock the local workspace"
    )
    expect(mockRotateNativePassword).not.toHaveBeenCalled()
  })
})

describe("desktop bootstrap failure and recovery handover", () => {
  const id = "acct_desktop_local_workspace"
  const device = (): LocalAccountRecord => ({ ...account(id, "Local"), protection: "device" })

  it("rolls back native activation when the fresh database cannot open and retries without replacement", async () => {
    mockDesktopLocalEnabled = true
    let records: LocalAccountRecord[] = []
    mockListAccounts.mockImplementation(async () => records)
    mockGetState.mockImplementation(async () => ({ activeAccountId: records[0]?.id ?? null }))
    mockBrowserVaultExists.mockResolvedValue(false)
    mockCreateRegistryAccount.mockImplementation(async () => {
      records = [device()]
      mockBrowserVaultExists.mockResolvedValue(true)
      return records[0]!
    })
    mockPrepareDatabase.mockRejectedValueOnce(new Error("database unavailable"))
    const store = makeStore()
    await expect(store.getState().load()).rejects.toThrow("database unavailable")
    expect(store.getState()).toMatchObject({
      unlockedAccountId: null,
      locked: true,
      loaded: true,
      accounts: [device()],
    })
    expect(mockUnbindLocalAccount).toHaveBeenCalled()
    expect(mockLockBrowserVault).toHaveBeenCalled()
    expect(mockClearAccountLocalState).toHaveBeenCalled()
    await store.getState().load()
    expect(store.getState().locked).toBe(false)
    expect(mockProvisionBrowserVault).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])("rejects invalid device-profile creation (Tauri=%s)", async (tauri) => {
    mockIsTauri = tauri
    const store = makeStore()
    await expect(
      store.getState().createAccount({
        id: tauri ? "acct_other" : id,
        displayName: "Local",
        password: "password-123",
        protection: "device",
      })
    ).rejects.toThrow("reserved")
    expect(mockProvisionBrowserVault).not.toHaveBeenCalled()
  })

  it("preserves the device secret and recovery material when password promotion rolls back", async () => {
    const store = makeStore()
    store.setState({ accounts: [device()], activeAccountId: id, unlockedAccountId: id })
    mockUpdatePasswordVerifier.mockRejectedValueOnce(new Error("registry offline"))
    await expect(store.getState().changePassword(id, "", "new-password")).rejects.toThrow(
      "registry offline"
    )
    expect(mockClearDesktopLocalPassword).not.toHaveBeenCalled()
    expect(mockClearDesktopRecovery).not.toHaveBeenCalled()
    expect(store.getState().accounts[0]?.protection).toBe("device")
    expect(mockChangeBrowserVaultPassword).toHaveBeenLastCalledWith(
      id,
      "new-password",
      "device-random-secret"
    )
    mockUpdatePasswordVerifier.mockResolvedValueOnce({ ...device(), protection: "password" })
    await store.getState().changePassword(id, "", "new-password")
    expect(store.getState().accounts[0]?.protection).toBe("password")
  })

  it("restores pending recovery after a protected unlock until acknowledgment succeeds", async () => {
    const store = makeStore()
    store.setState({
      accounts: [{ ...device(), protection: "password" }],
      activeAccountId: id,
      unlockedAccountId: null,
      locked: true,
    })
    await store.getState().unlockAccount(id, "user-password")
    expect(store.getState().pendingRecoveryKey).toBe("preserved-recovery-key")
    mockClearDesktopRecovery.mockRejectedValueOnce(new Error("delete denied"))
    store.getState().acknowledgeRecoveryKey()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().pendingRecoveryKey).toBe("preserved-recovery-key")
    expect(store.getState().error).toBe("delete denied")
    store.getState().acknowledgeRecoveryKey()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().pendingRecoveryKey).toBeNull()
  })
})

describe("unlock automatically on this device", () => {
  const id = "acct_remembered"
  const remembered = (): LocalAccountRecord => ({
    ...account(id, "Max"),
    rememberOnDevice: true,
  })
  const plain = (): LocalAccountRecord => account(id, "Max")

  beforeEach(() => {
    mockDesktopLocalEnabled = true
    mockIsTauri = true
  })

  describe("at boot", () => {
    it("opens a remembered profile from the secret store without a prompt", async () => {
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockResolvedValue("hunter22")
      const store = makeStore()

      await store.getState().load()

      expect(mockReadDeviceUnlockSecret).toHaveBeenCalledWith(id)
      expect(mockVerifyPassword).toHaveBeenCalledWith("hunter22", expect.anything(), id)
      expect(store.getState()).toMatchObject({
        unlockedAccountId: id,
        locked: false,
        autoUnlockFailure: null,
        error: null,
      })
    })

    it("falls back to the lock screen when the secret store cannot be read, keeping the secret", async () => {
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockRejectedValue(new Error("SECRET_STORE_LOCKED: denied"))
      const store = makeStore()

      await expect(store.getState().load()).resolves.toBeUndefined()

      expect(store.getState()).toMatchObject({
        loaded: true,
        unlockedAccountId: null,
        locked: true,
        error: null,
        autoUnlockFailure: {
          accountId: id,
          reason: "secret-store-unavailable",
          message: "SECRET_STORE_LOCKED: denied",
        },
      })
      expect(mockClearDeviceUnlockSecret).not.toHaveBeenCalled()
      expect(mockUpdateRememberOnDevice).not.toHaveBeenCalled()
    })

    it("turns the option off when the store holds no secret", async () => {
      let records = [remembered()]
      mockListAccounts.mockImplementation(async () => records)
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockUpdateRememberOnDevice.mockImplementation(async (accountId, enabled) => {
        records = [{ ...plain(), ...(enabled ? { rememberOnDevice: true } : {}) }]
        return records[0]!
      })
      mockReadDeviceUnlockSecret.mockResolvedValue(null)
      const store = makeStore()

      await store.getState().load()

      expect(mockUpdateRememberOnDevice).toHaveBeenCalledWith(id, false)
      expect(store.getState().autoUnlockFailure).toEqual({
        accountId: id,
        reason: "secret-missing",
      })
      expect(store.getState().locked).toBe(true)
      // The published list reflects the flag the registry now holds.
      expect(store.getState().accounts[0]?.rememberOnDevice).toBeUndefined()
    })

    it("forgets a secret the profile no longer opens with", async () => {
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockResolvedValue("old-password")
      mockVerifyPassword.mockResolvedValue(false)
      const store = makeStore()

      await store.getState().load()

      expect(mockClearDeviceUnlockSecret).toHaveBeenCalledWith(id)
      expect(mockUpdateRememberOnDevice).toHaveBeenCalledWith(id, false)
      expect(store.getState()).toMatchObject({
        locked: true,
        error: null,
        autoUnlockFailure: { accountId: id, reason: "secret-rejected" },
      })
    })

    it("reports other activation failures without failing the boot", async () => {
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockResolvedValue("hunter22")
      mockPrepareDatabase.mockRejectedValueOnce(new Error("database blocked"))
      const store = makeStore()

      await expect(store.getState().load()).resolves.toBeUndefined()

      expect(store.getState().autoUnlockFailure).toMatchObject({
        accountId: id,
        reason: "unlock-failed",
      })
      expect(store.getState().locked).toBe(true)
      // A good secret is not thrown away over an unrelated failure.
      expect(mockClearDeviceUnlockSecret).not.toHaveBeenCalled()
    })

    it("does not open anything by itself when the gate is forced on", async () => {
      mockDesktopLocalEnabled = false
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockResolvedValue("hunter22")
      const store = makeStore()

      await store.getState().load()

      expect(mockReadDeviceUnlockSecret).not.toHaveBeenCalled()
      expect(store.getState().locked).toBe(true)
    })

    it("leaves a profile that never opted in on the lock screen", async () => {
      mockListAccounts.mockResolvedValue([plain()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      const store = makeStore()

      await store.getState().load()

      expect(mockReadDeviceUnlockSecret).not.toHaveBeenCalled()
      expect(store.getState()).toMatchObject({ locked: true, autoUnlockFailure: null })
    })
  })

  describe("choosing it on the lock screen", () => {
    it("stores the proven password and flags the profile", async () => {
      mockListAccounts.mockResolvedValue([plain()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      const store = makeStore()
      await store.getState().load()

      await store.getState().unlockAccount(id, "hunter22", { rememberOnDevice: true })

      expect(mockSaveDeviceUnlockSecret).toHaveBeenCalledWith(id, "hunter22")
      expect(mockUpdateRememberOnDevice).toHaveBeenCalledWith(id, true)
      // Secret first, flag second: boot never sees a flag with no secret.
      expect(mockSaveDeviceUnlockSecret.mock.invocationCallOrder[0]).toBeLessThan(
        mockUpdateRememberOnDevice.mock.invocationCallOrder[0]!
      )
      expect(store.getState().unlockedAccountId).toBe(id)
      expect(store.getState().accounts.find((a) => a.id === id)?.rememberOnDevice).toBe(true)
    })

    it("fails the attempt with its own code when the store refuses, and rolls back", async () => {
      mockListAccounts.mockResolvedValue([plain()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockSaveDeviceUnlockSecret.mockRejectedValue(new Error("keychain denied"))
      const store = makeStore()
      await store.getState().load()

      await expect(
        store.getState().unlockAccount(id, "hunter22", { rememberOnDevice: true })
      ).rejects.toMatchObject({ code: "secret-store-unavailable" })

      expect(store.getState().unlockedAccountId).toBeNull()
      expect(mockUpdateRememberOnDevice).not.toHaveBeenCalled()
      expect(mockUnbindLocalAccount).toHaveBeenCalled()
    })

    it("unticking it turns the option off before anything opens", async () => {
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockRejectedValue(new Error("SECRET_STORE_LOCKED"))
      const store = makeStore()
      await store.getState().load()

      await store.getState().unlockAccount(id, "hunter22", { rememberOnDevice: false })

      expect(mockUpdateRememberOnDevice).toHaveBeenCalledWith(id, false)
      expect(mockClearDeviceUnlockSecret).toHaveBeenCalledWith(id)
      expect(mockSaveDeviceUnlockSecret).not.toHaveBeenCalled()
      expect(store.getState().unlockedAccountId).toBe(id)
    })

    it("leaves the stored choice alone when no option is passed", async () => {
      mockListAccounts.mockResolvedValue([plain()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      const store = makeStore()
      await store.getState().load()

      await store.getState().unlockAccount(id, "hunter22")

      expect(mockSaveDeviceUnlockSecret).not.toHaveBeenCalled()
      expect(mockUpdateRememberOnDevice).not.toHaveBeenCalled()
    })

    it("clears the boot failure once the profile is open", async () => {
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockRejectedValue(new Error("SECRET_STORE_LOCKED"))
      const store = makeStore()
      await store.getState().load()
      expect(store.getState().autoUnlockFailure).not.toBeNull()

      await store.getState().unlockAccount(id, "hunter22")

      expect(store.getState().autoUnlockFailure).toBeNull()
    })
  })

  describe("setRememberOnDevice from Settings", () => {
    async function unlockedStore(record: LocalAccountRecord) {
      mockListAccounts.mockResolvedValue([record])
      mockGetState.mockResolvedValue({ activeAccountId: record.id })
      const store = makeStore()
      await store.getState().load()
      await store.getState().unlockAccount(record.id, "hunter22")
      mockVerifyPassword.mockClear()
      return store
    }

    it("verifies the password without re-binding the host, then stores it", async () => {
      const store = await unlockedStore(plain())

      const updated = await store.getState().setRememberOnDevice(id, true, "hunter22")

      // Two arguments: no account id, so the host binding is untouched.
      expect(mockVerifyPassword).toHaveBeenCalledWith("hunter22", expect.anything())
      expect(mockSaveDeviceUnlockSecret).toHaveBeenCalledWith(id, "hunter22")
      expect(updated.rememberOnDevice).toBe(true)
    })

    it("refuses a wrong password and stores nothing", async () => {
      const store = await unlockedStore(plain())
      mockVerifyPassword.mockResolvedValue(false)

      await expect(store.getState().setRememberOnDevice(id, true, "nope")).rejects.toMatchObject({
        code: "invalid-password",
      })
      expect(mockSaveDeviceUnlockSecret).not.toHaveBeenCalled()
      expect(mockUpdateRememberOnDevice).not.toHaveBeenCalled()
    })

    it("requires the password to turn it on", async () => {
      const store = await unlockedStore(plain())

      await expect(store.getState().setRememberOnDevice(id, true)).rejects.toMatchObject({
        code: "password-required",
      })
    })

    it("turns it off without a password", async () => {
      const store = await unlockedStore(remembered())

      await store.getState().setRememberOnDevice(id, false)

      expect(mockUpdateRememberOnDevice).toHaveBeenCalledWith(id, false)
      expect(mockClearDeviceUnlockSecret).toHaveBeenCalledWith(id)
      expect(mockVerifyPassword).not.toHaveBeenCalled()
    })

    it("keeps the flag off even if the secret cannot be removed", async () => {
      const store = await unlockedStore(remembered())
      mockClearDeviceUnlockSecret.mockRejectedValue(new Error("store locked"))

      await expect(store.getState().setRememberOnDevice(id, false)).resolves.toMatchObject({
        id,
      })
      expect(mockUpdateRememberOnDevice).toHaveBeenCalledWith(id, false)
    })

    it("refuses the device-managed workspace, which has no typed password", async () => {
      const deviceId = "acct_desktop_local_workspace"
      mockListAccounts.mockResolvedValue([{ ...account(deviceId, "Local"), protection: "device" }])
      mockGetState.mockResolvedValue({ activeAccountId: deviceId })
      const store = makeStore()
      await store.getState().load()

      await expect(store.getState().setRememberOnDevice(deviceId, true, "x")).rejects.toThrow(
        /already opens on this device/
      )
    })

    it("is refused outside the desktop shell", async () => {
      const store = await unlockedStore(plain())
      mockDesktopLocalEnabled = false

      await expect(
        store.getState().setRememberOnDevice(id, true, "hunter22")
      ).rejects.toMatchObject({ code: "secret-store-unavailable" })
      expect(mockSaveDeviceUnlockSecret).not.toHaveBeenCalled()
    })
  })

  describe("keeping the stored password in step", () => {
    it("stores the new password after a change", async () => {
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockResolvedValue("hunter22")
      const store = makeStore()
      await store.getState().load()

      await store.getState().changePassword(id, "hunter22", "correct-horse-9")

      expect(mockSaveDeviceUnlockSecret).toHaveBeenCalledWith(id, "correct-horse-9")
    })

    it("turns the option off and says so when the new password cannot be stored", async () => {
      mockListAccounts.mockResolvedValue([remembered()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      mockReadDeviceUnlockSecret.mockResolvedValue("hunter22")
      const store = makeStore()
      await store.getState().load()
      mockSaveDeviceUnlockSecret.mockRejectedValue(new Error("keychain denied"))

      await expect(
        store.getState().changePassword(id, "hunter22", "correct-horse-9")
      ).rejects.toMatchObject({ code: "secret-store-unavailable" })

      expect(mockUpdateRememberOnDevice).toHaveBeenCalledWith(id, false)
      // The password change itself stood.
      expect(mockRotateNativePassword).toHaveBeenCalled()
    })

    it("does not touch the store for a profile that never opted in", async () => {
      mockListAccounts.mockResolvedValue([plain()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      const store = makeStore()
      await store.getState().load()
      await store.getState().unlockAccount(id, "hunter22")

      await store.getState().changePassword(id, "hunter22", "correct-horse-9")

      expect(mockSaveDeviceUnlockSecret).not.toHaveBeenCalled()
    })

    it("removes a deleted profile's stored password without failing the deletion", async () => {
      const other = account("acct_other", "Other")
      mockListAccounts.mockResolvedValue([remembered(), other])
      mockGetState.mockResolvedValue({ activeAccountId: other.id })
      mockClearDeviceUnlockSecret.mockRejectedValue(new Error("store locked"))
      const store = makeStore()
      await store.getState().load()

      await expect(store.getState().deleteAccount(id)).resolves.toMatchObject({ accountId: id })
      expect(mockClearDeviceUnlockSecret).toHaveBeenCalledWith(id)
    })
  })

  describe("switching", () => {
    const other = account("acct_other", "Other")

    async function unlockedOnOther(target: LocalAccountRecord) {
      mockListAccounts.mockResolvedValue([other, target])
      mockGetState.mockResolvedValue({ activeAccountId: other.id })
      const store = makeStore()
      await store.getState().load()
      await store.getState().unlockAccount(other.id, "hunter22")
      mockUnbindLocalAccount.mockClear()
      return store
    }

    it("refuses a switch with no credential BEFORE locking the current profile", async () => {
      const store = await unlockedOnOther(plain())

      await expect(store.getState().switchAccount(id)).rejects.toMatchObject({
        code: "password-required",
      })

      // Still inside the profile the owner was using.
      expect(store.getState().unlockedAccountId).toBe(other.id)
      expect(store.getState().locked).toBe(false)
      expect(mockUnbindLocalAccount).not.toHaveBeenCalled()
    })

    it("opens a remembered profile from the secret store", async () => {
      const store = await unlockedOnOther(remembered())
      mockReadDeviceUnlockSecret.mockResolvedValue("target-secret")

      await store.getState().switchAccount(id)

      expect(mockVerifyPassword).toHaveBeenLastCalledWith("target-secret", expect.anything(), id)
      expect(store.getState().unlockedAccountId).toBe(id)
    })

    it("forgets a stale stored password when the switch is refused", async () => {
      const store = await unlockedOnOther(remembered())
      mockReadDeviceUnlockSecret.mockResolvedValue("stale")
      mockVerifyPassword.mockResolvedValue(false)

      await expect(store.getState().switchAccount(id)).rejects.toMatchObject({
        code: "invalid-password",
      })
      expect(mockClearDeviceUnlockSecret).toHaveBeenCalledWith(id)
      expect(mockUpdateRememberOnDevice).toHaveBeenCalledWith(id, false)
    })
  })

  describe("never re-deciding an unlocked session", () => {
    it("a failed action followed by another boot read leaves the session open", async () => {
      mockListAccounts.mockResolvedValue([plain()])
      mockGetState.mockResolvedValue({ activeAccountId: id })
      const store = makeStore()
      await store.getState().load()
      await store.getState().unlockAccount(id, "hunter22")
      mockVerifyPassword.mockResolvedValue(false)
      mockRotateNativePassword.mockRejectedValueOnce(new Error("Invalid local account password."))
      await expect(
        store.getState().changePassword(id, "wrong", "correct-horse-9")
      ).rejects.toThrow()
      expect(store.getState().error).not.toBeNull()
      mockListAccounts.mockClear()

      await store.getState().load()

      expect(mockListAccounts).not.toHaveBeenCalled()
      expect(store.getState().unlockedAccountId).toBe(id)
      expect(store.getState().locked).toBe(false)
    })

    it("still retries a boot read that failed before anything was unlocked", async () => {
      mockListAccounts.mockRejectedValueOnce(new Error("registry blocked"))
      const store = makeStore()
      await expect(store.getState().load()).rejects.toThrow("registry blocked")
      mockListAccounts.mockResolvedValue([plain()])
      mockGetState.mockResolvedValue({ activeAccountId: id })

      await store.getState().load()

      expect(store.getState().error).toBeNull()
      expect(store.getState().accounts).toHaveLength(1)
    })
  })
})

describe("recovery key acknowledgement", () => {
  const localId = "acct_desktop_local_workspace"

  it("keeps the Local workspace's stored key when a second profile's key is acknowledged", async () => {
    mockDesktopLocalEnabled = true
    mockListAccounts.mockResolvedValue([{ ...account(localId, "Local"), protection: "device" }])
    mockGetState.mockResolvedValue({ activeAccountId: localId })
    const store = makeStore()
    await store.getState().load()
    expect(store.getState().activeAccountId).toBe(localId)

    // The manage dialog creates the second profile without activating it.
    await store
      .getState()
      .createAccount({ id: "acct_second", displayName: "Second", password: "secret-pass" })
    expect(store.getState().pendingRecoveryKeyAccountId).toBe("acct_second")

    store.getState().acknowledgeRecoveryKey()

    expect(mockClearDesktopRecovery).not.toHaveBeenCalled()
    expect(store.getState().pendingRecoveryKey).toBeNull()
    expect(store.getState().pendingRecoveryKeyAccountId).toBeNull()
  })

  it("clears the stored key when it is the Local workspace's own", async () => {
    mockDesktopLocalEnabled = true
    mockListAccounts.mockResolvedValue([{ ...account(localId, "Local"), protection: "password" }])
    mockGetState.mockResolvedValue({ activeAccountId: localId })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount(localId, "hunter22")
    expect(store.getState().pendingRecoveryKeyAccountId).toBe(localId)

    store.getState().acknowledgeRecoveryKey()
    await Promise.resolve()
    await Promise.resolve()

    expect(mockClearDesktopRecovery).toHaveBeenCalled()
  })

  it("does not let an unreadable secret store fail an unlock the password proved", async () => {
    mockDesktopLocalEnabled = true
    mockReadDesktopRecovery.mockRejectedValue(new Error("SECRET_STORE_LOCKED"))
    mockListAccounts.mockResolvedValue([{ ...account(localId, "Local"), protection: "password" }])
    mockGetState.mockResolvedValue({ activeAccountId: localId })
    const store = makeStore()
    await store.getState().load()

    await store.getState().unlockAccount(localId, "hunter22")

    expect(store.getState().unlockedAccountId).toBe(localId)
    expect(store.getState().pendingRecoveryKey).toBeNull()
  })
})
