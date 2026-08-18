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
  getSettingsMock.mockResolvedValue({})
  saveSettingsMock.mockResolvedValue(undefined)
})

afterEach(() => __setDocsProviderSecretsForTests(null))

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
    expect(await getGoogleDocsSettings()).toEqual({})
  })

  it("survives a settings read failure rather than breaking the picker", async () => {
    getSettingsMock.mockRejectedValue(new Error("db closed"))
    expect(await getGoogleDocsSettings()).toEqual({})
  })

  it("merges a patch without dropping sibling providers", async () => {
    getSettingsMock.mockResolvedValue({
      docsProviders: { google: { clientId: "cid" } },
    })
    await updateGoogleDocsSettings({ connected: true })
    expect(saveSettingsMock).toHaveBeenCalledWith({
      docsProviders: { google: { clientId: "cid", connected: true } },
    })
  })

  it("accepts a functional patch", async () => {
    getSettingsMock.mockResolvedValue({ docsProviders: { google: { clientId: "cid" } } })
    await updateGoogleDocsSettings((current) => ({ clientId: current.clientId, connected: false }))
    expect(saveSettingsMock).toHaveBeenCalledWith({
      docsProviders: { google: { clientId: "cid", connected: false } },
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
    expect(saveSettingsMock).toHaveBeenCalledWith({
      docsProviders: { google: { clientId: "cid", connected: false } },
    })
  })
})
