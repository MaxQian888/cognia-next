/** @jest-environment jsdom */
/**
 * Coverage for `probeDiscordIdentity`.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { probeDiscordIdentity, fetchDiscordBotUser, DiscordWhoamiError } from "./discord-whoami"

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
    mediaModelPolicy: "local_extract_only",
    createdAt: 0,
    updatedAt: 0,
  })
}

function meOk(payload: Record<string, unknown>) {
  return { status: 200, headers: {}, body: JSON.stringify(payload) }
}

/** Response for the second HTTP call — `GET /applications/@me`. */
function appOk(id: string) {
  return { status: 200, headers: {}, body: JSON.stringify({ id, name: "Cognia App" }) }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockHttp.mockReset()
  mockKeyring.mockReset()
})

describe("probeDiscordIdentity", () => {
  it("happy path persists global_name + discriminator + avatar + real application id", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("dc-token")
    mockHttp
      .mockResolvedValueOnce(
        meOk({
          id: "987654321098765432",
          username: "cogniabot",
          global_name: "Cognia",
          discriminator: "0042",
          avatar: "abc123",
          bot: true,
        })
      )
      .mockResolvedValueOnce(appOk("111222333444555666"))
    const result = await probeDiscordIdentity(ADAPTER_ID, { now: () => 1 })
    expect(result.botName).toBe("Cognia#0042")
    expect(result.botAvatar).toBe(
      "https://cdn.discordapp.com/avatars/987654321098765432/abc123.png"
    )
    expect(result.openId).toBe("987654321098765432")
    // appId comes from GET /applications/@me — never the username.
    expect(result.appId).toBe("111222333444555666")
    const appCall = mockHttp.mock.calls[1][0] as { url: string }
    expect(appCall.url).toBe("https://discord.com/api/v10/applications/@me")
    const row = await getDb().adapterInstances.get(ADAPTER_ID)
    expect(row?.lastWhoamiAt).toBe(1)
  })

  it("falls back to the bot user id (not the username) when the application probe fails", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("dc-token")
    mockHttp
      .mockResolvedValueOnce(meOk({ id: "987", username: "cogniabot" }))
      .mockResolvedValueOnce({ status: 403, headers: {}, body: '{"message":"nope"}' })
    const result = await probeDiscordIdentity(ADAPTER_ID)
    expect(result.appId).toBe("987")
    expect(result.appId).not.toBe("cogniabot")
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

describe("fetchDiscordBotUser (shared probe helper)", () => {
  it("returns the bot user object on success", async () => {
    mockHttp.mockResolvedValueOnce(meOk({ id: "42", username: "bot" }))
    const user = await fetchDiscordBotUser("tok")
    expect(user).toMatchObject({ id: "42", username: "bot" })
    const call = mockHttp.mock.calls[0][0] as { url: string; headers: Record<string, string> }
    expect(call.url).toBe("https://discord.com/api/v10/users/@me")
    expect(call.headers.Authorization).toBe("Bot tok")
  })

  it("throws DiscordWhoamiError on HTTP error", async () => {
    mockHttp.mockResolvedValueOnce({ status: 401, headers: {}, body: "{}" })
    await expect(fetchDiscordBotUser("bad")).rejects.toBeInstanceOf(DiscordWhoamiError)
  })
})
