import { generateDeviceKeyMaterial } from "@/lib/account-sync/crypto"

import { createMemoryKeyring } from "./testing/memory-keyring"
import {
  AccountSyncVaultLockedError,
  __clearAccountSyncKeyCache,
  createAccountSyncVault,
} from "./vault-store"

const SCOPE = { localAccountId: "local_1", spaceId: "s".repeat(43) }

beforeEach(() => __clearAccountSyncKeyCache())

describe("createAccountSyncVault", () => {
  it("keeps device keys per profile and space, and caches the import", async () => {
    const store = createMemoryKeyring()
    const vault = createAccountSyncVault(SCOPE, store)
    expect(await vault.loadDeviceKeys()).toBeNull()
    const material = await generateDeviceKeyMaterial()
    const saved = await vault.saveDeviceKeys(material)
    expect(saved.deviceId).toBe(material.deviceId)
    expect([...store.values.keys()]).toEqual([`local_1:${SCOPE.spaceId}:device`])
    expect(await vault.loadDeviceKeys()).toBe(saved)
    __clearAccountSyncKeyCache()
    expect((await vault.loadDeviceKeys())!.signPub).toBe(material.signPub)

    const otherProfile = createAccountSyncVault({ ...SCOPE, localAccountId: "local_2" }, store)
    expect(await otherProfile.loadDeviceKeys()).toBeNull()
  })

  it("sees another tab forgetting or replacing the keys", async () => {
    const store = createMemoryKeyring()
    const vault = createAccountSyncVault(SCOPE, store)
    const saved = await vault.saveDeviceKeys(await generateDeviceKeyMaterial())
    expect(await vault.loadDeviceKeys()).toBe(saved)
    const otherTab = createAccountSyncVault(SCOPE, store)
    const replaced = await generateDeviceKeyMaterial()
    store.values.set(`local_1:${SCOPE.spaceId}:device`, JSON.stringify(replaced))
    expect((await vault.loadDeviceKeys())!.deviceId).toBe(replaced.deviceId)
    await otherTab.forgetDevice({ at: 1, seq: 1, by: "dev_X" })
    expect(await vault.loadDeviceKeys()).toBeNull()
  })

  it("refuses to work, and drops cached keys, while the store is not durable", async () => {
    const store = createMemoryKeyring()
    const vault = createAccountSyncVault(SCOPE, store)
    await vault.saveDeviceKeys(await generateDeviceKeyMaterial())
    store.persistent = false
    await expect(vault.loadDeviceKeys()).rejects.toBeInstanceOf(AccountSyncVaultLockedError)
    expect(() => vault.assertAvailable()).toThrow(AccountSyncVaultLockedError)
    store.persistent = true
    expect(await vault.loadDeviceKeys()).not.toBeNull()
  })

  it("stores the key chain", async () => {
    const vault = createAccountSyncVault(SCOPE, createMemoryKeyring())
    expect(await vault.loadKeyChain()).toBeNull()
    const chain = new Map([[1, new Uint8Array(32).fill(1)]])
    await vault.saveKeyChain(chain)
    expect(await vault.loadKeyChain()).toEqual(chain)
  })

  it("moves the pin forward only", async () => {
    const vault = createAccountSyncVault(SCOPE, createMemoryKeyring())
    expect(await vault.loadPin()).toBeNull()
    await vault.advancePin({ genesisHash: "g", seq: 4, hash: "h4", epoch: 2 })
    expect(
      await vault.advancePin({ genesisHash: "g", seq: 2, hash: "h2", epoch: 1 })
    ).toMatchObject({ seq: 4 })
    expect(
      await vault.advancePin({ genesisHash: "g", seq: 5, hash: "h5", epoch: 2 })
    ).toMatchObject({ seq: 5 })
    expect(await vault.loadPin()).toMatchObject({ seq: 5, hash: "h5" })
  })

  it("forgets the device but keeps the pin and records the removal", async () => {
    const store = createMemoryKeyring()
    const vault = createAccountSyncVault(SCOPE, store)
    await vault.saveDeviceKeys(await generateDeviceKeyMaterial())
    await vault.saveKeyChain(new Map([[1, new Uint8Array(32)]]))
    await vault.advancePin({ genesisHash: "g", seq: 1, hash: "h", epoch: 1 })
    await vault.forgetDevice({ at: 5, seq: 3, by: "dev_X" })
    expect(await vault.loadDeviceKeys()).toBeNull()
    expect(await vault.loadKeyChain()).toBeNull()
    expect(await vault.loadPin()).not.toBeNull()
    expect(await vault.loadRemoval()).toEqual({ at: 5, seq: 3, by: "dev_X" })
    // Enrolling again clears the record.
    await vault.saveDeviceKeys(await generateDeviceKeyMaterial())
    expect(await vault.loadRemoval()).toBeNull()
  })

  it("refuses a corrupt pin", async () => {
    const store = createMemoryKeyring()
    await store.save(`local_1:${SCOPE.spaceId}:pin`, JSON.stringify({ seq: "x" }))
    await expect(createAccountSyncVault(SCOPE, store).loadPin()).rejects.toThrow(/pin/)
  })
})
