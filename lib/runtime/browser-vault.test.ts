import "fake-indexeddb/auto"

import Dexie from "dexie"

import {
  BROWSER_VAULT_DB_NAME,
  BROWSER_VAULT_ARGON2_MEMORY_KIB,
  BrowserVaultRepository,
  BrowserVaultSession,
  __createLegacyPbkdf2VaultRecordForTesting,
  __resetBrowserVaultForTesting,
  __setBrowserVaultArgon2ParametersForTesting,
  changeBrowserVaultPassword,
  deleteBrowserVault,
  getActiveBrowserVault,
  lockBrowserVault,
  provisionBrowserVault,
  resetBrowserVaultPasswordWithRecoveryKey,
  unlockBrowserVault,
  verifyBrowserVaultPassword,
} from "./browser-vault"

const ACCOUNT_ID = "acct_vault"

beforeEach(async () => {
  __resetBrowserVaultForTesting()
  __setBrowserVaultArgon2ParametersForTesting(32)
  await Dexie.delete(BROWSER_VAULT_DB_NAME)
})

afterAll(async () => {
  __resetBrowserVaultForTesting()
  await Dexie.delete(BROWSER_VAULT_DB_NAME)
})

describe("legacy PBKDF2 (v1) vaults", () => {
  // The migration to Argon2 must not strand anybody. A v1 record is the state
  // EVERY existing browser account is in until its password is next rotated,
  // so if this path breaks, those accounts are unopenable — with only the
  // one-time recovery key, which most people will not have kept, as a way back.
  it("still unlocks with the correct password", async () => {
    const record = await __createLegacyPbkdf2VaultRecordForTesting(ACCOUNT_ID, "correct horse")

    const session = await BrowserVaultSession.unlockWithPassword(record, "correct horse")

    expect(session.accountId).toBe(ACCOUNT_ID)
    expect(session.isUnlocked()).toBe(true)
  })

  it("still refuses the wrong password", async () => {
    const record = await __createLegacyPbkdf2VaultRecordForTesting(ACCOUNT_ID, "correct horse")

    await expect(BrowserVaultSession.unlockWithPassword(record, "wrong horse")).rejects.toThrow()
  })

  it("unlocks and rotates onto Argon2 through the repository", async () => {
    await new BrowserVaultRepository().put(
      await __createLegacyPbkdf2VaultRecordForTesting(ACCOUNT_ID, "correct horse")
    )

    await expect(unlockBrowserVault(ACCOUNT_ID, "correct horse")).resolves.toBeUndefined()
    expect(getActiveBrowserVault()?.accountId).toBe(ACCOUNT_ID)

    await changeBrowserVaultPassword(ACCOUNT_ID, "correct horse", "next horse")
    const rotated = await new BrowserVaultRepository().get(ACCOUNT_ID)
    expect(rotated?.version).toBe(2)
    expect(rotated?.passwordKdf.algorithm).toBe("Argon2id")
    await expect(unlockBrowserVault(ACCOUNT_ID, "next horse")).resolves.toBeUndefined()
  })
})

// A record's OWN parameters drive its derivation, so a record minted under
// different (e.g. older, or later-hardened) settings must still validate —
// otherwise raising the cost parameters locks every existing vault out.
it("accepts an Argon2 record whose parameters differ from the current ones", async () => {
  const created = await BrowserVaultSession.create(ACCOUNT_ID, "correct horse", 10)
  __setBrowserVaultArgon2ParametersForTesting(64)

  await expect(
    BrowserVaultSession.unlockWithPassword(created.record, "correct horse")
  ).resolves.toBeDefined()
})

it("wraps the master key with both the password and one-time recovery key", async () => {
  const created = await BrowserVaultSession.create(ACCOUNT_ID, "correct horse", 10)

  expect(created.record.version).toBe(2)
  expect(created.record.passwordKdf).toMatchObject({
    algorithm: "Argon2id",
    memoryKiB: 32,
    timeCost: 1,
    parallelism: 1,
  })
  expect(BROWSER_VAULT_ARGON2_MEMORY_KIB).toBe(19_456)
  expect(created.record.passwordWrap.ciphertext).not.toBe(created.record.recoveryWrap.ciphertext)
  expect(created.recoveryKey).toMatch(/^[A-Za-z0-9_-]+$/)

  const fromPassword = await BrowserVaultSession.unlockWithPassword(created.record, "correct horse")
  const fromRecovery = await BrowserVaultSession.unlockWithRecoveryKey(
    created.record,
    created.recoveryKey
  )
  const secret = await fromPassword.encryptSecret("provider:anthropic", "sk-secret")
  await expect(fromRecovery.decryptSecret("provider:anthropic", secret)).resolves.toBe("sk-secret")
})

it("rejects an incorrect password and tampered ciphertext", async () => {
  const created = await BrowserVaultSession.create(ACCOUNT_ID, "correct horse")

  await expect(
    BrowserVaultSession.unlockWithPassword(created.record, "wrong horse")
  ).rejects.toBeDefined()

  const tampered = structuredClone(created.record)
  tampered.passwordWrap.ciphertext = `${tampered.passwordWrap.ciphertext.slice(0, -1)}A`
  await expect(
    BrowserVaultSession.unlockWithPassword(tampered, "correct horse")
  ).rejects.toBeDefined()
})

it("fails closed after lock and does not retain a usable master key", async () => {
  const { session } = await BrowserVaultSession.create(ACCOUNT_ID, "correct horse")
  const encrypted = await session.encryptSecret("device-jwt", "jwt-value")

  session.lock()

  expect(session.isUnlocked()).toBe(false)
  await expect(session.decryptSecret("device-jwt", encrypted)).rejects.toThrow(/locked/i)
})

it("binds encrypted secrets to their account and logical name", async () => {
  const created = await BrowserVaultSession.create(ACCOUNT_ID, "correct horse")
  const encrypted = await created.session.encryptSecret("device-jwt", "jwt-value")

  await expect(created.session.decryptSecret("oidc-token", encrypted)).rejects.toBeDefined()
})

it("persists only wrapped Vault material in the account-level repository", async () => {
  const repository = new BrowserVaultRepository()
  const created = await BrowserVaultSession.create(ACCOUNT_ID, "correct horse")

  await repository.put(created.record)

  await expect(repository.get(ACCOUNT_ID)).resolves.toEqual(created.record)
  expect(JSON.stringify(created.record)).not.toContain("correct horse")
  expect(JSON.stringify(created.record)).not.toContain(created.recoveryKey)
  repository.close()
})

it("stores multiple named secret envelopes in the Vault database and removes them with the account", async () => {
  await provisionBrowserVault(ACCOUNT_ID, "correct horse")
  const vault = getActiveBrowserVault()!

  await vault.storeSecret("companion:first:device-jwt", "jwt-first", 10)
  await vault.storeSecret("companion:second:device-jwt", "jwt-second", 20)

  await expect(vault.loadSecret("companion:first:device-jwt")).resolves.toBe("jwt-first")
  await expect(vault.loadSecret("companion:second:device-jwt")).resolves.toBe("jwt-second")

  const repository = new BrowserVaultRepository()
  expect(
    JSON.stringify(await repository.getSecret(ACCOUNT_ID, "companion:first:device-jwt"))
  ).not.toContain("jwt-first")
  repository.close()

  lockBrowserVault()
  await unlockBrowserVault(ACCOUNT_ID, "correct horse")
  await expect(getActiveBrowserVault()!.loadSecret("companion:second:device-jwt")).resolves.toBe(
    "jwt-second"
  )

  await deleteBrowserVault(ACCOUNT_ID)
  const afterDelete = new BrowserVaultRepository()
  await expect(
    afterDelete.getSecret(ACCOUNT_ID, "companion:first:device-jwt")
  ).resolves.toBeUndefined()
  afterDelete.close()
})

it("keeps only the active account master key in the process singleton", async () => {
  await provisionBrowserVault(ACCOUNT_ID, "correct horse")
  expect(getActiveBrowserVault()?.accountId).toBe(ACCOUNT_ID)

  lockBrowserVault()
  expect(getActiveBrowserVault()).toBeNull()

  await unlockBrowserVault(ACCOUNT_ID, "correct horse")
  expect(getActiveBrowserVault()?.isUnlocked()).toBe(true)
})

it("can provision a secondary account without replacing the active account key", async () => {
  await provisionBrowserVault(ACCOUNT_ID, "correct horse")

  await provisionBrowserVault("acct_secondary", "other password", false)

  expect(getActiveBrowserVault()?.accountId).toBe(ACCOUNT_ID)
  await expect(unlockBrowserVault("acct_secondary", "other password")).resolves.toBeUndefined()
})

it("verifies a password without replacing or locking the active Vault session", async () => {
  await provisionBrowserVault(ACCOUNT_ID, "correct horse")
  const active = getActiveBrowserVault()

  await expect(verifyBrowserVaultPassword(ACCOUNT_ID, "correct horse")).resolves.toBe(true)
  await expect(verifyBrowserVaultPassword(ACCOUNT_ID, "wrong horse")).resolves.toBe(false)

  expect(getActiveBrowserVault()).toBe(active)
  expect(active?.isUnlocked()).toBe(true)
})

it("does not persist a new password if preparing its replacement session fails", async () => {
  await provisionBrowserVault(ACCOUNT_ID, "old password")
  lockBrowserVault()
  const importKey = crypto.subtle.importKey.bind(crypto.subtle)
  let importCount = 0
  const importSpy = jest
    .spyOn(crypto.subtle, "importKey")
    .mockImplementation((...args: Parameters<SubtleCrypto["importKey"]>) => {
      importCount += 1
      if (importCount === 3) {
        return Promise.reject(new Error("session import failed"))
      }
      return importKey(...args)
    })

  await expect(
    changeBrowserVaultPassword(ACCOUNT_ID, "old password", "new password", 20)
  ).rejects.toThrow("session import failed")
  importSpy.mockRestore()

  await expect(unlockBrowserVault(ACCOUNT_ID, "old password")).resolves.toBeUndefined()
  lockBrowserVault()
  await expect(unlockBrowserVault(ACCOUNT_ID, "new password")).rejects.toBeDefined()
})

it("rewraps the password copy without invalidating the recovery copy", async () => {
  const recoveryKey = await provisionBrowserVault(ACCOUNT_ID, "old password")

  await changeBrowserVaultPassword(ACCOUNT_ID, "old password", "new password", 20)
  lockBrowserVault()

  await expect(unlockBrowserVault(ACCOUNT_ID, "old password")).rejects.toBeDefined()
  await expect(unlockBrowserVault(ACCOUNT_ID, "new password")).resolves.toBeUndefined()

  const repository = new BrowserVaultRepository()
  const record = await repository.get(ACCOUNT_ID)
  expect(record).toBeDefined()
  await expect(
    BrowserVaultSession.unlockWithRecoveryKey(record!, recoveryKey)
  ).resolves.toBeDefined()
  repository.close()
})

describe("resetBrowserVaultPasswordWithRecoveryKey", () => {
  it("rewraps the master key under a new password and leaves the vault unlocked", async () => {
    const recoveryKey = await provisionBrowserVault(ACCOUNT_ID, "correct horse")
    await getActiveBrowserVault()!.storeSecret("provider:anthropic", "sk-secret")
    lockBrowserVault()

    await resetBrowserVaultPasswordWithRecoveryKey(ACCOUNT_ID, recoveryKey, "brand new phrase")

    const session = getActiveBrowserVault()
    expect(session?.accountId).toBe(ACCOUNT_ID)
    await expect(session!.loadSecret("provider:anthropic")).resolves.toBe("sk-secret")
  })

  it("makes the new password the one that unlocks and retires the old one", async () => {
    const recoveryKey = await provisionBrowserVault(ACCOUNT_ID, "correct horse")
    await resetBrowserVaultPasswordWithRecoveryKey(ACCOUNT_ID, recoveryKey, "brand new phrase")
    lockBrowserVault()

    await expect(unlockBrowserVault(ACCOUNT_ID, "brand new phrase")).resolves.toBeUndefined()
    lockBrowserVault()
    await expect(unlockBrowserVault(ACCOUNT_ID, "correct horse")).rejects.toBeDefined()
  })

  it("keeps the recovery key usable — it is the vault's root of trust, not a nonce", async () => {
    const recoveryKey = await provisionBrowserVault(ACCOUNT_ID, "correct horse")
    await resetBrowserVaultPasswordWithRecoveryKey(ACCOUNT_ID, recoveryKey, "second phrase")
    await resetBrowserVaultPasswordWithRecoveryKey(ACCOUNT_ID, recoveryKey, "third phrase")
    lockBrowserVault()

    await expect(unlockBrowserVault(ACCOUNT_ID, "third phrase")).resolves.toBeUndefined()
  })

  it("refuses a wrong recovery key without touching the stored record", async () => {
    await provisionBrowserVault(ACCOUNT_ID, "correct horse")
    const other = await BrowserVaultSession.create("acct_other", "unrelated")
    lockBrowserVault()

    await expect(
      resetBrowserVaultPasswordWithRecoveryKey(ACCOUNT_ID, other.recoveryKey, "brand new phrase")
    ).rejects.toBeDefined()
    expect(getActiveBrowserVault()).toBeNull()
    await expect(unlockBrowserVault(ACCOUNT_ID, "correct horse")).resolves.toBeUndefined()
  })

  it("refuses a malformed recovery key", async () => {
    const recoveryKey = await provisionBrowserVault(ACCOUNT_ID, "correct horse")
    lockBrowserVault()

    await expect(
      resetBrowserVaultPasswordWithRecoveryKey(ACCOUNT_ID, `${recoveryKey}extra`, "new phrase")
    ).rejects.toThrow(/malformed/i)
  })

  it("refuses an empty new password before writing anything", async () => {
    const recoveryKey = await provisionBrowserVault(ACCOUNT_ID, "correct horse")
    lockBrowserVault()

    await expect(
      resetBrowserVaultPasswordWithRecoveryKey(ACCOUNT_ID, recoveryKey, "   ")
    ).rejects.toThrow(/required/i)
    await expect(unlockBrowserVault(ACCOUNT_ID, "correct horse")).resolves.toBeUndefined()
  })

  it("refuses an account with no vault", async () => {
    await expect(
      resetBrowserVaultPasswordWithRecoveryKey("acct_missing", "AAAA", "new phrase")
    ).rejects.toThrow(/not provisioned/i)
  })
})
