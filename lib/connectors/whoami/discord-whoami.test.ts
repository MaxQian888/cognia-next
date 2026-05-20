/**
 * Coverage for `probeDiscordIdentity`.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { probeDiscordIdentity, DiscordWhoamiError } from "./discord-whoami"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))

const mockHttp = connectorsHttpRequest as jest.Mock
const mockKeyring = connectorsKeyringGet as jest.Mock

const ADAPTER_ID = "dc-1"

function seedRow(type: "discord" | "telegram" = "discord") {
  return getDb().adapterInstances.put({
    id: ADAPTER_ID,
    type,
    displayName: "Discord",
    enabled: true,
    transportMode: "gateway",
    settings: {},
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

function meOk(payload: Record<string, unknown>) {
  return { status: 200, headers: {}, body: JSON.stringify(payload) }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockHttp.mockReset()
  mockKeyring.mockReset()
})

describe("probeDiscordIdentity", () => {
  it("happy path persists global_name + discriminator + avatar", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("dc-token")
    mockHttp.mockResolvedValueOnce(
      meOk({
        id: "987654321098765432",
        username: "cogniabot",
        global_name: "Cognia",
        discriminator: "0042",
        avatar: "abc123",
        bot: true,
      })
    )
    const result = await probeDiscordIdentity(ADAPTER_ID, { now: () => 1 })
    expect(result.botName).toBe("Cognia#0042")
    expect(result.botAvatar).toBe(
      "https://cdn.discordapp.com/avatars/987654321098765432/abc123.png"
    )
    expect(result.openId).toBe("987654321098765432")
    expect(result.appId).toBe("cogniabot")
    const row = await getDb().adapterInstances.get(ADAPTER_ID)
    expect(row?.lastWhoamiAt).toBe(1)
  })

  it("omits botAvatar when avatar hash is null", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("dc-token")
    mockHttp.mockResolvedValueOnce(meOk({ id: "1", username: "x", global_name: "X" }))
    const result = await probeDiscordIdentity(ADAPTER_ID)
    expect(result.botAvatar).toBeUndefined()
  })

  it("falls back to username then bot-id when display fields are missing", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("dc-token")
    mockHttp.mockResolvedValueOnce(meOk({ id: "999" }))
    const result = await probeDiscordIdentity(ADAPTER_ID)
    expect(result.botName).toBe("bot-999")
  })

  it("throws when row is missing", async () => {
    await expect(probeDiscordIdentity("ghost")).rejects.toThrow(/does not exist/)
  })

  it("throws when row is wrong type", async () => {
    await seedRow("telegram")
    await expect(probeDiscordIdentity(ADAPTER_ID)).rejects.toThrow(/expected "discord"/)
  })

  it("throws when token is missing", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue(null)
    await expect(probeDiscordIdentity(ADAPTER_ID)).rejects.toThrow(/Bot token/)
  })

  it("throws on HTTP 401", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("dc-token")
    mockHttp.mockResolvedValueOnce({
      status: 401,
      headers: {},
      body: JSON.stringify({ message: "401: Unauthorized" }),
    })
    await expect(probeDiscordIdentity(ADAPTER_ID)).rejects.toBeInstanceOf(DiscordWhoamiError)
  })

  it("throws when response has no id", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("dc-token")
    mockHttp.mockResolvedValueOnce(meOk({ message: "ratelimited" }))
    await expect(probeDiscordIdentity(ADAPTER_ID)).rejects.toThrow(/no id/)
  })
})
