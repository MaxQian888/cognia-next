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

import { buildSlackOAuthState, handleSlackOAuth, parseSlackOAuthState } from "./oauth-handler"

const slackRow = {
  id: "slack-1",
  type: "slack",
  displayName: "Slack",
  settings: { redirectUri: "cognia://connector/oauth/slack" },
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetAdapter.mockResolvedValue(slackRow)
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
    mockHttp.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({
        ok: true,
        access_token: "xoxb-123",
        bot_user_id: "U_BOT",
        team: { id: "T1", name: "Acme" },
        authed_user: { id: "U_USER", access_token: "xoxp-456" },
      }),
    })

    const team = await handleSlackOAuth("the-code", { state: buildSlackOAuthState("slack-1", "n") })

    expect(team.teamId).toBe("T1")
    expect(team.teamName).toBe("Acme")
    expect(mockKeyringSet).toHaveBeenCalledWith("slack-1", "botToken", "xoxb-123")
    expect(mockKeyringSet).toHaveBeenCalledWith("slack-1", "user_token", "xoxp-456")
    // Connected-team metadata stamped on the row.
    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "slack-1",
      expect.objectContaining({
        settings: expect.objectContaining({
          connectedTeam: expect.objectContaining({ teamId: "T1" }),
        }),
      })
    )
    // The POST went to oauth.v2.access with the code.
    const req = mockHttp.mock.calls[0][0]
    expect(req.url).toBe("https://slack.com/api/oauth.v2.access")
    expect(req.body).toContain("code=the-code")
  })

  it("throws when Slack returns ok:false", async () => {
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
    mockKeyringGet.mockResolvedValue(null)
    await expect(
      handleSlackOAuth("c", { state: buildSlackOAuthState("slack-1", "n") })
    ).rejects.toThrow(/clientId\/clientSecret/i)
  })
})
