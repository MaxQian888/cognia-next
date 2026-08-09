import { createLocalKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"
import {
  applyProxyPasswordMutation,
  isProxyPasswordConfigured,
  migrateLegacyProxyPassword,
  NETWORK_PROXY_PASSWORD_KEY,
} from "./proxy-credentials"

jest.mock("@/lib/credentials/keyring-store", () => ({
  createLocalKeyringStore: jest.fn(),
}))

const mockedCreateStore = jest.mocked(createLocalKeyringStore)
let values: Map<string, string>
let store: jest.Mocked<KeyringStore>

beforeEach(() => {
  values = new Map()
  store = {
    save: jest.fn(async (key, value) => {
      values.set(key, value)
    }),
    load: jest.fn(async (key) => values.get(key) ?? null),
    delete: jest.fn(async (key) => {
      values.delete(key)
    }),
    isPersistent: jest.fn(() => true),
  }
  mockedCreateStore.mockReturnValue(store)
})

it("migrates a legacy Dexie password only after keyring verification", async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  const result = await migrateLegacyProxyPassword(
    {
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      password: "secret",
    },
    persist
  )

  expect(store.save).toHaveBeenCalledWith(NETWORK_PROXY_PASSWORD_KEY, "secret")
  expect(result.settings).not.toHaveProperty("password")
  expect(persist).toHaveBeenCalledWith(result.settings)
  expect(result).toMatchObject({ credentialConfigured: true, migrated: true })
})

it("rejects migration when the keyring cannot read the saved value", async () => {
  store.load.mockResolvedValue(null)
  await expect(
    migrateLegacyProxyPassword({ ...DEFAULT_NETWORK_PROXY_SETTINGS, password: "secret" })
  ).rejects.toThrow("PROXY_CREDENTIAL_UNAVAILABLE")
})

it("reports an existing password without returning the secret", async () => {
  values.set(NETWORK_PROXY_PASSWORD_KEY, "secret")
  await expect(isProxyPasswordConfigured()).resolves.toBe(true)
})

it("implements keep, replace, and explicit clear mutations", async () => {
  values.set(NETWORK_PROXY_PASSWORD_KEY, "old")
  await expect(applyProxyPasswordMutation({ kind: "keep" })).resolves.toBe(true)
  await expect(applyProxyPasswordMutation({ kind: "replace", value: "new" })).resolves.toBe(true)
  expect(values.get(NETWORK_PROXY_PASSWORD_KEY)).toBe("new")
  await expect(applyProxyPasswordMutation({ kind: "clear" })).resolves.toBe(false)
  expect(values.has(NETWORK_PROXY_PASSWORD_KEY)).toBe(false)
})
