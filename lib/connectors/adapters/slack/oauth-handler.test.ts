const mockGetAdapter = jest.fn()
const mockUpdateAdapter = jest.fn().mockResolvedValue(undefined)
const mockKeyringGet = jest.fn()
const mockKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockHttp = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: (...a: unknown[]) => mockGetAdapter(...a),
  updateAdapterInstance: (...a: unknown[]) => mockUpdateAdapter(...a),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: (...a: unknown[]) => mockHttp(...a),
  connectorsKeyringGet: (...a: unknown[]) => mockKeyringGet(...a),
  connectorsKeyringSet: (...a: unknown[]) => mockKeyringSet(...a),
}))

const mockGetPending = jest.fn()
const mockClearPending = jest.fn().mockResolvedValue(undefined)
jest.mock("./oauth-pending", () => ({
  getSlackOAuthPending: (...a: unknown[]) => mockGetPending(...a),
  clearSlackOAuthPending: (...a: unknown[]) => mockClearPending(...a),
}))

import { buildSlackOAuthState, handleSlackOAuth, parseSlackOAuthState } from "./oauth-handler"

const slackRow = {
  id: "slack-1",
  type: "slack",
  displayName: "Slack",
  settings: {},
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
}

const RELAY = "https://relay.example/oauth/connector/slack/callback"

/** Make `getSlackOAuthPending` answer with a record matching `state`. */
function primePending(state: string, redirectUri = RELAY) {
  mockGetPending.mockResolvedValue({ state, redirectUri, ts: Date.now() })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetAdapter.mockResolvedValue(slackRow)
  mockClearPending.mockResolvedValue(undefined)
  mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
    name === "clientId" ? "cid" : name === "clientSecret" ? "csecret" : null
  )
})

describe("slack oauth state", () => {
  it("round-trips the adapter id", () => {
    const state = buildSlackOAuthState("slack-1", "nonce9")
    expect(parseSlackOAuthState(state)).toEqual({ adapterId: "slack-1", nonce: "nonce9" })
  })
  it("rejects a malformed state", () => {
    expect(parseSlackOAuthState("garbage")).toBeNull()
    expect(parseSlackOAuthState("lark:x:y")).toBeNull()
  })
})

describe("handleSlackOAuth", () => {
  it("throws on malformed state", async () => {
    await expect(handleSlackOAuth("code", { state: "garbage" })).rejects.toThrow(/state malformed/i)
  })

  it("exchanges the code and stores the bot token", async () => {
    primePending(buildSlackOAuthState("slack-1", "n"))
    mockHttp.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({
        ok: true,
        access_token: "xoxb-123",
        bot_user_id: "U_BOT",
        scope: "chat:write,channels:read",
        team: { id: "T1", name: "Acme" },
        authed_user: { id: "U_USER", access_token: "xoxp-456" },
      }),
    })

    const team = await handleSlackOAuth("the-code", { state: buildSlackOAuthState("slack-1", "n") })

    expect(team.teamId).toBe("T1")
    expect(team.teamName).toBe("Acme")
    expect(mockKeyringSet).toHaveBeenCalledWith("slack-1", "botToken", "xoxb-123")
    // Canonical key is "userToken" — the same one buildSlackAdapter reads.
    expect(mockKeyringSet).toHaveBeenCalledWith("slack-1", "userToken", "xoxp-456")
    expect(mockKeyringSet).not.toHaveBeenCalledWith("slack-1", "user_token", expect.anything())
    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "slack-1",
      expect.objectContaining({
        credentialsRef: expect.objectContaining({
          accounts: expect.arrayContaining(["botToken", "userToken"]),
        }),
      })
    )
    // Connected-team metadata stamped on the row.
    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "slack-1",
      expect.objectContaining({
        settings: expect.objectContaining({
          connectedTeam: expect.objectContaining({ teamId: "T1" }),
          // Granted scopes are normalized (split, deduped, sorted) and stored.
          connectedScopes: expect.objectContaining({
            scopes: ["channels:read", "chat:write"],
          }),
        }),
      })
    )
    // The POST went to oauth.v2.access with the code.
    const req = mockHttp.mock.calls[0][0]
    expect(req.url).toBe("https://slack.com/api/oauth.v2.access")
    expect(req.body).toContain("code=the-code")
    // Slack requires the exchange to replay the redirect sent to authorize;
    // it comes from the pending record, not from adapter settings.
    expect(req.body).toContain(`redirect_uri=${encodeURIComponent(RELAY)}`)
  })

  it("throws when Slack returns ok:false", async () => {
    primePending(buildSlackOAuthState("slack-1", "n"))
    mockHttp.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error: "invalid_code" }),
    })
    await expect(
      handleSlackOAuth("bad", { state: buildSlackOAuthState("slack-1", "n") })
    ).rejects.toThrow("invalid_code")
  })

  it("throws when client credentials are missing", async () => {
    primePending(buildSlackOAuthState("slack-1", "n"))
    mockKeyringGet.mockResolvedValue(null)
    await expect(
      handleSlackOAuth("c", { state: buildSlackOAuthState("slack-1", "n") })
    ).rejects.toThrow(/clientId\/clientSecret/i)
  })
})

describe("handleSlackOAuth — durable state check", () => {
  // The renderer's sessionStorage copy is a desktop-only pre-check. This
  // record is the check that holds headless and across a restart, so it is
  // what must reject a forged or replayed redirect.
  const state = buildSlackOAuthState("slack-1", "n")

  it("refuses when no authorization is pending", async () => {
    mockGetPending.mockResolvedValue(null)
    await expect(handleSlackOAuth("code", { state })).rejects.toThrow(/no pending authorization/i)
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("refuses a state that does not match the pending record", async () => {
    primePending(buildSlackOAuthState("slack-1", "a-different-nonce"))
    await expect(handleSlackOAuth("code", { state })).rejects.toThrow(/does not match/i)
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("spends the record before the exchange so a replay cannot reuse it", async () => {
    primePending(state)
    mockHttp.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: true, access_token: "xoxb-1", team: { id: "T1" } }),
    })

    await handleSlackOAuth("the-code", { state })

    expect(mockClearPending).toHaveBeenCalledWith("slack-1")
    expect(mockClearPending.mock.invocationCallOrder[0]).toBeLessThan(
      mockHttp.mock.invocationCallOrder[0]
    )
  })

  it("spends the record even when the exchange fails", async () => {
    primePending(state)
    mockHttp.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error: "invalid_code" }),
    })

    await expect(handleSlackOAuth("bad", { state })).rejects.toThrow("invalid_code")
    // Otherwise a failed attempt would leave a replayable record behind.
    expect(mockClearPending).toHaveBeenCalledWith("slack-1")
  })
})
