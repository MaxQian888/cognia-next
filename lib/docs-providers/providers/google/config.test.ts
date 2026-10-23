import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests } from "./state"
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))

import { getSettings, saveSettings } from "@/lib/db/settings"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import {
  DOCS_PROVIDER_KEYRING_NAMESPACE,
  GOOGLE_DOCS_SCOPES,
  GOOGLE_DOCS_SCOPE_STRING,
  GOOGLE_TOKENS_KEY,
  __setDocsProviderSecretsForTests,
  clearGoogleConnection,
  getGoogleClientSecret,
  getGoogleDocsSettings,
  loadGoogleTokens,
  saveGoogleClientSecret,
  saveGoogleTokens,
  updateGoogleDocsSettings,
  subscribeGoogleDocsSettings,
} from "./config"

const getSettingsMock = getSettings as jest.Mock
const saveSettingsMock = saveSettings as jest.Mock

function memoryStore(): KeyringStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    save: async (k, v) => void map.set(k, v),
    load: async (k) => map.get(k) ?? null,
    delete: async (k) => void map.delete(k),
  }
}

let store: ReturnType<typeof memoryStore>

beforeEach(() => {
  jest.clearAllMocks()
  store = memoryStore()
  __setDocsProviderSecretsForTests(store)
  __setGoogleStatePortForTests(createGoogleDocsTestHost(store).call)
  getSettingsMock.mockResolvedValue({})
  saveSettingsMock.mockImplementation(async (input) => {
    const current = await getSettingsMock()
    return { ...current, ...(typeof input === "function" ? input(current) : input) }
  })
})

afterEach(() => {
  __setDocsProviderSecretsForTests(null)
  __setGoogleStatePortForTests(null)
})

describe("scopes", () => {
  it("asks for the three read scopes the provider actually uses", () => {
    expect([...GOOGLE_DOCS_SCOPES]).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ])
    expect(GOOGLE_DOCS_SCOPE_STRING).toBe(GOOGLE_DOCS_SCOPES.join(" "))
  })

  it("never requests a write scope", () => {
    for (const scope of GOOGLE_DOCS_SCOPES) expect(scope).toMatch(/\.readonly$/)
  })

  it("uses a namespace distinct from the backup destinations' keyring", () => {
    expect(DOCS_PROVIDER_KEYRING_NAMESPACE).toBe("docs-providers")
    expect(DOCS_PROVIDER_KEYRING_NAMESPACE).not.toBe("backup-destinations")
  })
})

describe("settings", () => {
  it("returns an empty object when nothing is configured", async () => {
    expect(await getGoogleDocsSettings()).toMatchObject({ connected: false })
  })

  it("survives a settings read failure rather than breaking the picker", async () => {
    getSettingsMock.mockRejectedValue(new Error("db closed"))
    expect(await getGoogleDocsSettings()).toMatchObject({ connected: false })
  })

  it("merges a patch without dropping sibling providers", async () => {
    getSettingsMock.mockResolvedValue({
      docsProviders: { google: { clientId: "cid" } },
    })
    await updateGoogleDocsSettings({ connected: true })
    expect(saveSettingsMock).toHaveBeenCalledWith(expect.any(Function))
    expect((await saveSettingsMock.mock.results[0].value).docsProviders.google).toEqual({
      clientId: "cid",
      connected: true,
    })
  })

  it("accepts a functional patch", async () => {
    getSettingsMock.mockResolvedValue({ docsProviders: { google: { clientId: "cid" } } })
    await updateGoogleDocsSettings((current) => ({ clientId: current.clientId, connected: false }))
    expect(saveSettingsMock).toHaveBeenCalledWith(expect.any(Function))
    expect((await saveSettingsMock.mock.results[0].value).docsProviders.google).toEqual({
      clientId: "cid",
      connected: false,
    })
  })
})

describe("secrets", () => {
  it("round-trips the client secret through the keyring", async () => {
    await saveGoogleClientSecret("shh")
    expect(await getGoogleClientSecret()).toBe("shh")
  })

  it("round-trips tokens", async () => {
    const tokens = { accessToken: "at", refreshToken: "rt", expiresAt: 123, scope: "s" }
    await saveGoogleTokens(tokens)
    expect(await loadGoogleTokens()).toEqual({ ...tokens, tokenType: undefined })
  })

  it("returns null for absent, malformed, or incomplete token blobs", async () => {
    expect(await loadGoogleTokens()).toBeNull()
    store.map.set(GOOGLE_TOKENS_KEY, "not json")
    expect(await loadGoogleTokens()).toBeNull()
    store.map.set(GOOGLE_TOKENS_KEY, JSON.stringify({ accessToken: "a" }))
    expect(await loadGoogleTokens()).toBeNull()
  })

  it("drops non-string fields instead of trusting a tampered blob", async () => {
    store.map.set(
      GOOGLE_TOKENS_KEY,
      JSON.stringify({ accessToken: "a", expiresAt: 1, refreshToken: 5, scope: {} })
    )
    expect(await loadGoogleTokens()).toEqual({
      accessToken: "a",
      expiresAt: 1,
      refreshToken: undefined,
      scope: undefined,
      tokenType: undefined,
    })
  })
})

describe("clearGoogleConnection", () => {
  it("removes the tokens and keeps only the client id", async () => {
    getSettingsMock.mockResolvedValue({
      docsProviders: { google: { clientId: "cid", connected: true, accountEmail: "a@b.c" } },
    })
    await saveGoogleTokens({ accessToken: "at", expiresAt: 1 })
    await clearGoogleConnection()
    expect(store.map.has(GOOGLE_TOKENS_KEY)).toBe(false)
    expect(saveSettingsMock).toHaveBeenCalledWith(expect.any(Function))
    expect((await saveSettingsMock.mock.results[0].value).docsProviders.google).toEqual({
      clientId: "cid",
      connected: false,
    })
  })
})

it("applies preference patches to the latest queued settings instead of reviving connected state", async () => {
  getSettingsMock.mockResolvedValue({
    docsProviders: { google: { clientId: "old", connected: true } },
  })
  saveSettingsMock.mockImplementationOnce(async (input) => {
    const current = { docsProviders: { google: { clientId: "old", connected: false } } }
    return { ...current, ...(typeof input === "function" ? input(current) : input) }
  })
  await expect(updateGoogleDocsSettings({ clientId: "new" })).resolves.toMatchObject({
    clientId: "new",
    connected: false,
  })
})

it("notifies only committed state and removes unsubscribed observers", async () => {
  const listener = jest.fn()
  const unsubscribe = subscribeGoogleDocsSettings(listener)
  try {
    await updateGoogleDocsSettings({ clientId: "committed" })
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientId: "committed", connected: false })
    )
    saveSettingsMock.mockRejectedValueOnce(new Error("save failed"))
    await expect(updateGoogleDocsSettings({ connected: false })).rejects.toThrow("save failed")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    await updateGoogleDocsSettings({ connected: false })
    expect(listener).toHaveBeenCalledTimes(1)
  } finally {
    unsubscribe()
  }
})

it("does not let a failing observer break a committed settings update", async () => {
  const unsubscribe = subscribeGoogleDocsSettings(() => {
    throw new Error("observer")
  })
  try {
    await expect(updateGoogleDocsSettings({ clientId: "committed" })).resolves.toMatchObject({
      clientId: "committed",
      connected: false,
    })
  } finally {
    unsubscribe()
  }
})
