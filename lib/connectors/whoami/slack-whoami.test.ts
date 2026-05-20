/**
 * Coverage for `probeSlackIdentity`.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { probeSlackIdentity, SlackWhoamiError } from "./slack-whoami"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))

const mockHttp = connectorsHttpRequest as jest.Mock
const mockKeyring = connectorsKeyringGet as jest.Mock

const ADAPTER_ID = "sl-1"

function seedRow(type: "slack" | "telegram" = "slack") {
  return getDb().adapterInstances.put({
    id: ADAPTER_ID,
    type,
    displayName: "Slack",
    enabled: true,
    transportMode: "gateway",
    settings: { transport: "socket-mode" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
  })
}

function authOk(payload: Record<string, unknown>) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, ...payload }),
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockHttp.mockReset()
  mockKeyring.mockReset()
})

describe("probeSlackIdentity", () => {
  it("happy path persists workspace identity + team key", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("xoxb-token")
    mockHttp.mockResolvedValueOnce(
      authOk({
        user: "cognia",
        team: "Workspace",
        team_id: "T0ABC",
        user_id: "U0XYZ",
        bot_id: "B0BOT",
        url: "https://example.slack.com",
      })
    )
    const result = await probeSlackIdentity(ADAPTER_ID, { now: () => 1 })
    expect(result.botName).toBe("cognia @ Workspace")
    expect(result.openId).toBe("U0XYZ")
    expect(result.appId).toBe("B0BOT")
    expect(result.tenantKey).toBe("T0ABC")
    const row = await getDb().adapterInstances.get(ADAPTER_ID)
    expect(row?.lastWhoamiAt).toBe(1)
  })

  it("omits team in display name when missing", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("xoxb-token")
    mockHttp.mockResolvedValueOnce(authOk({ user: "cognia", user_id: "U0" }))
    const result = await probeSlackIdentity(ADAPTER_ID)
    expect(result.botName).toBe("cognia")
  })

  it("falls back to bot-<id> when user is missing", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("xoxb-token")
    mockHttp.mockResolvedValueOnce(authOk({ user_id: "U9" }))
    const result = await probeSlackIdentity(ADAPTER_ID)
    expect(result.botName).toBe("bot-U9")
  })

  it("throws when row is missing", async () => {
    await expect(probeSlackIdentity("ghost")).rejects.toThrow(/does not exist/)
  })

  it("throws on wrong row type", async () => {
    await seedRow("telegram")
    await expect(probeSlackIdentity(ADAPTER_ID)).rejects.toThrow(/expected "slack"/)
  })

  it("throws when token missing", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue(null)
    await expect(probeSlackIdentity(ADAPTER_ID)).rejects.toThrow(/Bot token/)
  })

  it("throws on HTTP 5xx", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("xoxb-token")
    mockHttp.mockResolvedValueOnce({ status: 500, headers: {}, body: "boom" })
    await expect(probeSlackIdentity(ADAPTER_ID)).rejects.toBeInstanceOf(SlackWhoamiError)
  })

  it("throws when Slack returns ok=false", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("xoxb-token")
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error: "invalid_auth" }),
    })
    await expect(probeSlackIdentity(ADAPTER_ID)).rejects.toThrow(/invalid_auth/)
  })
})
