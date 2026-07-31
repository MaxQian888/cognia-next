import "fake-indexeddb/auto"

import Dexie from "dexie"

import {
  BROWSER_VAULT_DB_NAME,
  BROWSER_VAULT_PBKDF2_ITERATIONS,
  BrowserVaultRepository,
  BrowserVaultSession,
  __resetBrowserVaultForTesting,
  changeBrowserVaultPassword,
  deleteBrowserVault,
  getActiveBrowserVault,
  lockBrowserVault,
  provisionBrowserVault,
  unlockBrowserVault,
  verifyBrowserVaultPassword,
} from "./browser-vault"

const ACCOUNT_ID = "acct_vault"

beforeEach(async () => {
  __resetBrowserVaultForTesting()
  await Dexie.delete(BROWSER_VAULT_DB_NAME)
})

afterAll(async () => {
  __resetBrowserVaultForTesting()
  await Dexie.delete(BROWSER_VAULT_DB_NAME)
})

it("wraps the master key with both the password and one-time recovery key", async () => {
  const created = await BrowserVaultSession.create(ACCOUNT_ID, "correct horse", 10)

  expect(created.record.passwordKdf.iterations).toBe(BROWSER_VAULT_PBKDF2_ITERATIONS)
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
