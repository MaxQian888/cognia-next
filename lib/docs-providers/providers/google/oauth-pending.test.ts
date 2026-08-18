jest.mock("./config", () => ({ docsProviderSecrets: jest.fn() }))

import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { docsProviderSecrets } from "./config"
import {
  GOOGLE_OAUTH_PENDING_KEY,
  GOOGLE_OAUTH_PENDING_TTL_MS,
  clearGoogleOAuthPending,
  getGoogleOAuthPending,
  setGoogleOAuthPending,
} from "./oauth-pending"

const secretsMock = docsProviderSecrets as jest.Mock
const map = new Map<string, string>()
const store: KeyringStore = {
  save: async (k, v) => void map.set(k, v),
  load: async (k) => map.get(k) ?? null,
  delete: async (k) => void map.delete(k),
}

const PENDING = {
  state: "google:abc",
  codeVerifier: "verifier",
  redirectUri: "http://127.0.0.1:7842/oauth/docs/google/callback",
}

beforeEach(() => {
  map.clear()
  secretsMock.mockReturnValue(store)
})

describe("google oauth pending", () => {
  it("round-trips a record and stamps the write time", async () => {
    await setGoogleOAuthPending(PENDING, 1000)
    expect(await getGoogleOAuthPending(1000)).toEqual({ ...PENDING, ts: 1000 })
  })

  it("returns null when nothing is pending", async () => {
    expect(await getGoogleOAuthPending()).toBeNull()
  })

  it("expires a record past the TTL so an abandoned attempt cannot be replayed", async () => {
    await setGoogleOAuthPending(PENDING, 0)
    expect(await getGoogleOAuthPending(GOOGLE_OAUTH_PENDING_TTL_MS)).not.toBeNull()
    expect(await getGoogleOAuthPending(GOOGLE_OAUTH_PENDING_TTL_MS + 1)).toBeNull()
  })

  it("rejects malformed or partial records", async () => {
    map.set(GOOGLE_OAUTH_PENDING_KEY, "not json")
    expect(await getGoogleOAuthPending()).toBeNull()
    map.set(GOOGLE_OAUTH_PENDING_KEY, JSON.stringify({ state: "s", ts: 1 }))
    expect(await getGoogleOAuthPending()).toBeNull()
  })

  it("clears on use", async () => {
    await setGoogleOAuthPending(PENDING, 0)
    await clearGoogleOAuthPending()
    expect(map.has(GOOGLE_OAUTH_PENDING_KEY)).toBe(false)
  })
})
