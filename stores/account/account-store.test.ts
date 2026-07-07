/**
 * @jest-environment jsdom
 */

import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"

import type { AccountStoreDependencies } from "./account-store"

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
}))

const mockCreatePasswordVerifier = jest.fn<Promise<PasswordVerifierRecord>, [string]>()
const mockVerifyPassword = jest.fn<Promise<boolean>, [string, PasswordVerifierRecord]>()

jest.mock("@/lib/accounts/password-client", () => ({
  createPasswordVerifier: mockCreatePasswordVerifier,
  verifyPassword: mockVerifyPassword,
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

const mockDropAccountDatabase = jest.fn<Promise<void>, [string]>()
const mockPurgeAccountLocalState = jest.fn<Promise<void>, [string]>()
const mockActivateAccountLocalState = jest.fn<Promise<void>, [string]>()
const mockClearAccountLocalState = jest.fn<void, []>()

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

function makeStore() {
  const dependencies: Partial<AccountStoreDependencies> = {
    dropAccountDatabase: mockDropAccountDatabase,
    purgeAccountLocalState: mockPurgeAccountLocalState,
    activateAccountLocalState: mockActivateAccountLocalState,
    clearAccountLocalState: mockClearAccountLocalState,
  }
  return createAccountStore(dependencies)
}

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
  mockListAccounts.mockResolvedValue([])
  mockGetState.mockResolvedValue({ activeAccountId: null })
  mockCreatePasswordVerifier.mockImplementation(async (password) => verifier(password))
  mockVerifyPassword.mockResolvedValue(true)
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

    expect(mockVerifyPassword).toHaveBeenCalledWith("secret", alpha.passwordVerifier)
    expect(mockSetActiveAccountId).toHaveBeenCalledWith("acct_alpha")
    expect(mockActivateAccountDatabase).toHaveBeenCalledWith("acct_alpha")
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

    expect(mockVerifyPassword).toHaveBeenLastCalledWith("beta-password", beta.passwordVerifier)
    expect(mockSetActiveAccountId).toHaveBeenLastCalledWith("acct_beta")
    expect(mockActivateAccountDatabase).toHaveBeenLastCalledWith("acct_beta")
    expect(mockActivateAccountLocalState).toHaveBeenLastCalledWith("acct_beta")
    expect(store.getState().activeAccountId).toBe("acct_beta")
    expect(store.getState().unlockedAccountId).toBe("acct_beta")
    expect(store.getState().accountRevision).toBe(2)
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

    store.getState().lock()

    expect(mockClearAccountDatabaseSelection).toHaveBeenCalled()
    expect(mockClearAccountLocalState).toHaveBeenCalled()
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().locked).toBe(true)
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

  it("changes a password after verifying the current one and re-minting the verifier", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const store = makeStore()
    await store.getState().load()
    await store.getState().unlockAccount("acct_alpha", "old-password")

    const updated = await store
      .getState()
      .changePassword("acct_alpha", "old-password", "new-secret")

    expect(mockVerifyPassword).toHaveBeenLastCalledWith("old-password", alpha.passwordVerifier)
    expect(mockCreatePasswordVerifier).toHaveBeenLastCalledWith("new-secret")
    expect(mockUpdatePasswordVerifier).toHaveBeenCalledWith("acct_alpha", verifier("new-secret"))
    expect(updated.passwordVerifier).toEqual(verifier("new-secret"))
    expect(store.getState().accounts[0].passwordVerifier).toEqual(verifier("new-secret"))
    expect(store.getState().error).toBeNull()
  })

  it("rejects a password change when the current password is wrong", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    mockVerifyPassword.mockResolvedValueOnce(false)
    const store = makeStore()
    await store.getState().load()

    await expect(
      store.getState().changePassword("acct_alpha", "wrong", "new-secret")
    ).rejects.toThrow(/Invalid local account password/)

    expect(mockCreatePasswordVerifier).not.toHaveBeenCalled()
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

    await store.getState().deleteAccount("acct_beta")

    expect(mockDeleteRegistryAccount).toHaveBeenCalledWith("acct_beta", {
      replacementAccountId: undefined,
    })
    expect(mockDropAccountDatabase).toHaveBeenCalledWith("acct_beta")
    expect(mockPurgeAccountLocalState).toHaveBeenCalledWith("acct_beta")
    expect(store.getState().accounts.map((item) => item.id)).toEqual(["acct_alpha"])
    expect(store.getState().unlockedAccountId).toBe("acct_alpha")
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

    await store.getState().deleteAccount("acct_alpha", { replacementAccountId: "acct_beta" })

    expect(mockDeleteRegistryAccount).toHaveBeenCalledWith("acct_alpha", {
      replacementAccountId: "acct_beta",
    })
    expect(mockClearAccountDatabaseSelection).toHaveBeenCalled()
    expect(mockClearAccountLocalState).toHaveBeenCalled()
    expect(store.getState().activeAccountId).toBe("acct_beta")
    expect(store.getState().unlockedAccountId).toBeNull()
    expect(store.getState().locked).toBe(true)
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
    store.getState().lock()

    expect(mockDropAccountDatabase).toHaveBeenCalledWith("acct_beta")
    expect(window.localStorage.getItem("cognia-account-acct_beta:panel")).toBeNull()
    expect(window.localStorage.getItem("cognia-artifacts:acct_beta:item")).toBeNull()
    expect(window.localStorage.getItem("cognia-agent-teams:acct_beta:item")).toBeNull()
    expect(window.localStorage.getItem("cognia-account-acct_alpha:panel")).toBe("keep")
  })
})

describe("account store dev unlock persistence", () => {
  // jest runs with NODE_ENV !== "production", so the sessionStorage-backed dev
  // unlock is active here. A fresh store sharing the same window.sessionStorage
  // simulates a page reload.
  it("restores the unlocked account across a reload in dev builds", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount("acct_alpha", "secret")

    mockActivateAccountDatabase.mockClear()
    mockActivateAccountLocalState.mockClear()
    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().unlockedAccountId).toBe("acct_alpha")
    expect(reloaded.getState().locked).toBe(false)
    expect(reloaded.getState().accountRevision).toBe(1)
    expect(mockActivateAccountDatabase).toHaveBeenCalledWith("acct_alpha")
    expect(mockActivateAccountLocalState).toHaveBeenCalledWith("acct_alpha")
  })

  it("does not restore when the active account differs from the remembered one", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount("acct_alpha", "secret")

    mockGetState.mockResolvedValue({ activeAccountId: "acct_beta" })
    mockActivateAccountDatabase.mockClear()
    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().unlockedAccountId).toBeNull()
    expect(reloaded.getState().locked).toBe(true)
    expect(mockActivateAccountDatabase).not.toHaveBeenCalled()
  })

  it("does not restore when the remembered active account no longer exists", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount("acct_alpha", "secret")

    mockListAccounts.mockResolvedValue([])
    mockActivateAccountDatabase.mockClear()
    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().unlockedAccountId).toBeNull()
    expect(mockActivateAccountDatabase).not.toHaveBeenCalled()
  })

  it("re-locks after lock() clears the remembered dev unlock", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockListAccounts.mockResolvedValue([alpha])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount("acct_alpha", "secret")
    first.getState().lock()

    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().unlockedAccountId).toBeNull()
    expect(reloaded.getState().locked).toBe(true)
  })

  it("clears the remembered dev unlock when the active account is deleted", async () => {
    const alpha = account("acct_alpha", "Alpha")
    const beta = account("acct_beta", "Beta")
    mockListAccounts.mockResolvedValue([alpha, beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_alpha" })
    const first = makeStore()
    await first.getState().load()
    await first.getState().unlockAccount("acct_alpha", "secret")
    await first.getState().deleteAccount("acct_alpha", { replacementAccountId: "acct_beta" })

    mockListAccounts.mockResolvedValue([beta])
    mockGetState.mockResolvedValue({ activeAccountId: "acct_beta" })
    const reloaded = makeStore()
    await reloaded.getState().load()

    expect(reloaded.getState().unlockedAccountId).toBeNull()
    expect(reloaded.getState().locked).toBe(true)
  })
})
