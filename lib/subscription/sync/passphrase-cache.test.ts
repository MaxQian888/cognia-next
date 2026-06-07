let settings: Record<string, unknown> = {}
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settings,
}))

const secrets = new Map<string, string>()
jest.mock("@/lib/keyring", () => ({
  getSecret: async (ref: { namespace: string; key: string }) =>
    secrets.get(`${ref.namespace}/${ref.key}`) ?? null,
  setSecret: async (ref: { namespace: string; key: string }, value: string) => {
    secrets.set(`${ref.namespace}/${ref.key}`, value)
  },
  clearSecret: async (ref: { namespace: string; key: string }) => {
    secrets.delete(`${ref.namespace}/${ref.key}`)
  },
}))

import {
  SUBSCRIPTION_SYNC_PASSPHRASE_REF,
  clearSubscriptionSyncPassphrase,
  forgetSubscriptionSyncPassphrase,
  getSubscriptionSyncPassphrase,
  hasSubscriptionSyncPassphrase,
  loadPersistedSubscriptionSyncPassphrase,
  persistSubscriptionSyncPassphrase,
  setSubscriptionSyncPassphrase,
} from "./passphrase-cache"

const KEYRING_KEY = `${SUBSCRIPTION_SYNC_PASSPHRASE_REF.namespace}/${SUBSCRIPTION_SYNC_PASSPHRASE_REF.key}`

beforeEach(() => {
  settings = {}
  secrets.clear()
})

afterEach(() => {
  clearSubscriptionSyncPassphrase()
})

describe("session cache", () => {
  it("stores and clears", () => {
    expect(hasSubscriptionSyncPassphrase()).toBe(false)
    setSubscriptionSyncPassphrase("pw")
    expect(getSubscriptionSyncPassphrase()).toBe("pw")
    setSubscriptionSyncPassphrase(null)
    expect(hasSubscriptionSyncPassphrase()).toBe(false)
  })

  it("treats the empty string as null", () => {
    setSubscriptionSyncPassphrase("")
    expect(hasSubscriptionSyncPassphrase()).toBe(false)
  })
})

describe("persistSubscriptionSyncPassphrase", () => {
  it("writes to the keyring only when the user opted in", async () => {
    await persistSubscriptionSyncPassphrase("pw")
    expect(secrets.has(KEYRING_KEY)).toBe(false)

    settings = { webdavSync: { rememberPassphrase: true } }
    await persistSubscriptionSyncPassphrase("pw")
    expect(secrets.get(KEYRING_KEY)).toBe("pw")
  })

  it("ignores empty passphrases", async () => {
    settings = { webdavSync: { rememberPassphrase: true } }
    await persistSubscriptionSyncPassphrase("")
    expect(secrets.has(KEYRING_KEY)).toBe(false)
  })
})

describe("loadPersistedSubscriptionSyncPassphrase", () => {
  it("hydrates the cache from the keyring when opted in", async () => {
    settings = { webdavSync: { rememberPassphrase: true } }
    secrets.set(KEYRING_KEY, "stored")
    expect(await loadPersistedSubscriptionSyncPassphrase()).toBe(true)
    expect(getSubscriptionSyncPassphrase()).toBe("stored")
  })

  it("returns false when not opted in or nothing stored", async () => {
    secrets.set(KEYRING_KEY, "stored")
    expect(await loadPersistedSubscriptionSyncPassphrase()).toBe(false)

    settings = { webdavSync: { rememberPassphrase: true } }
    secrets.clear()
    expect(await loadPersistedSubscriptionSyncPassphrase()).toBe(false)
  })

  it("is a no-op when the cache already holds a value", async () => {
    setSubscriptionSyncPassphrase("session")
    secrets.set(KEYRING_KEY, "stored")
    settings = { webdavSync: { rememberPassphrase: true } }
    expect(await loadPersistedSubscriptionSyncPassphrase()).toBe(true)
    expect(getSubscriptionSyncPassphrase()).toBe("session")
  })
})

describe("forgetSubscriptionSyncPassphrase", () => {
  it("wipes both the cache and the keyring copy", async () => {
    setSubscriptionSyncPassphrase("pw")
    secrets.set(KEYRING_KEY, "pw")
    await forgetSubscriptionSyncPassphrase()
    expect(hasSubscriptionSyncPassphrase()).toBe(false)
    expect(secrets.has(KEYRING_KEY)).toBe(false)
  })
})
