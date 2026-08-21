/**
 * Slack pending-authorization store.
 *
 * The record is the authoritative CSRF check on both hosts (the renderer's
 * sessionStorage copy is a desktop-only pre-check), so the TTL, the clear-on-use
 * contract and the malformed-input handling are what these tests pin.
 */

const mockKeyringGet = jest.fn()
const mockKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: (adapterId: string, credential: string) =>
    mockKeyringGet(adapterId, credential),
  connectorsKeyringSet: (adapterId: string, credential: string, value: string) =>
    mockKeyringSet(adapterId, credential, value),
  connectorsKeyringDelete: (adapterId: string, credential: string) =>
    mockKeyringDelete(adapterId, credential),
}))

import {
  SLACK_OAUTH_PENDING_CREDENTIAL,
  clearSlackOAuthPending,
  getSlackOAuthPending,
  setSlackOAuthPending,
} from "./oauth-pending"

const NOW = 1_700_000_000_000
const RECORD = { state: "slack:sl1:nonce", redirectUri: "https://relay.example/cb" }

beforeEach(() => {
  mockKeyringGet.mockReset()
  mockKeyringSet.mockReset().mockResolvedValue(undefined)
  mockKeyringDelete.mockReset().mockResolvedValue(undefined)
})

describe("setSlackOAuthPending", () => {
  it("stamps the write time so the TTL has something to measure", async () => {
    await setSlackOAuthPending("sl1", RECORD, NOW)
    expect(mockKeyringSet).toHaveBeenCalledWith(
      "sl1",
      SLACK_OAUTH_PENDING_CREDENTIAL,
      JSON.stringify({ ...RECORD, ts: NOW })
    )
  })
})

describe("getSlackOAuthPending", () => {
  it("round-trips a fresh record", async () => {
    mockKeyringGet.mockResolvedValue(JSON.stringify({ ...RECORD, ts: NOW }))
    await expect(getSlackOAuthPending("sl1", NOW + 1000)).resolves.toEqual({ ...RECORD, ts: NOW })
  })

  it("evicts and refuses a record past its TTL", async () => {
    mockKeyringGet.mockResolvedValue(JSON.stringify({ ...RECORD, ts: NOW }))
    // An abandoned authorization must not stay replayable forever.
    await expect(getSlackOAuthPending("sl1", NOW + 10 * 60 * 1000 + 1)).resolves.toBeNull()
    expect(mockKeyringDelete).toHaveBeenCalledWith("sl1", SLACK_OAUTH_PENDING_CREDENTIAL)
  })

  it("keeps a record that is exactly at the TTL boundary", async () => {
    mockKeyringGet.mockResolvedValue(JSON.stringify({ ...RECORD, ts: NOW }))
    await expect(getSlackOAuthPending("sl1", NOW + 10 * 60 * 1000)).resolves.not.toBeNull()
  })

  it("returns null for an absent record", async () => {
    mockKeyringGet.mockResolvedValue(null)
    await expect(getSlackOAuthPending("sl1", NOW)).resolves.toBeNull()
  })

  it("returns null for non-JSON", async () => {
    mockKeyringGet.mockResolvedValue("{not json")
    await expect(getSlackOAuthPending("sl1", NOW)).resolves.toBeNull()
  })

  it.each([
    ["missing state", { redirectUri: "https://r", ts: NOW }],
    ["missing redirectUri", { state: "s", ts: NOW }],
    ["missing ts", { state: "s", redirectUri: "https://r" }],
  ])("returns null for a record %s", async (_label, record) => {
    mockKeyringGet.mockResolvedValue(JSON.stringify(record))
    await expect(getSlackOAuthPending("sl1", NOW)).resolves.toBeNull()
  })

  it("reads a locked or absent store as 'no pending', not as a crash", async () => {
    mockKeyringGet.mockRejectedValue(new Error("keyring locked"))
    await expect(getSlackOAuthPending("sl1", NOW)).resolves.toBeNull()
  })
})

describe("clearSlackOAuthPending", () => {
  it("deletes the credential", async () => {
    await clearSlackOAuthPending("sl1")
    expect(mockKeyringDelete).toHaveBeenCalledWith("sl1", SLACK_OAUTH_PENDING_CREDENTIAL)
  })

  it("swallows a delete failure — the TTL is the backstop", async () => {
    mockKeyringDelete.mockRejectedValue(new Error("nope"))
    await expect(clearSlackOAuthPending("sl1")).resolves.toBeUndefined()
  })
})
