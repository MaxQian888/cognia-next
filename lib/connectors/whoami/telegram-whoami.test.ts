/** @jest-environment jsdom */
/**
 * Coverage for `probeTelegramIdentity`.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { probeTelegramIdentity, TelegramWhoamiError } from "./telegram-whoami"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))

const mockHttp = connectorsHttpRequest as jest.Mock
const mockKeyring = connectorsKeyringGet as jest.Mock

const ADAPTER_ID = "tg-1"

function seedRow(overrides: Partial<AdapterInstanceRow> = {}) {
  return getDb().adapterInstances.put({
    id: ADAPTER_ID,
    type: "telegram",
    displayName: "TG",
    enabled: true,
    transportMode: "longpoll",
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
    ...overrides,
  })
}

function getMeOk(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      ok: true,
      result: {
        id: 123456,
        is_bot: true,
        first_name: "Cognia",
        username: "cognia_bot",
        ...overrides,
      },
    }),
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockHttp.mockReset()
  mockKeyring.mockReset()
})

describe("probeTelegramIdentity", () => {
  it("happy path persists @username and id", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("tg-token")
    mockHttp.mockResolvedValueOnce(getMeOk())
    const result = await probeTelegramIdentity(ADAPTER_ID, { now: () => 1_700 })
    expect(result.botName).toBe("@cognia_bot")
    expect(result.openId).toBe("123456")
    const row = await getDb().adapterInstances.get(ADAPTER_ID)
    expect(row?.lastWhoamiResult?.botName).toBe("@cognia_bot")
    expect(row?.lastWhoamiAt).toBe(1_700)
  })

  it("falls back to first_name when username is missing", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("tg-token")
    mockHttp.mockResolvedValueOnce(getMeOk({ username: undefined, first_name: "Helper" }))
    const result = await probeTelegramIdentity(ADAPTER_ID)
    expect(result.botName).toBe("Helper")
  })

  it("throws when the row is missing", async () => {
    await expect(probeTelegramIdentity("ghost")).rejects.toThrow(/does not exist/)
  })

  it("throws when the row is the wrong type", async () => {
    await seedRow({ type: "discord" })
    await expect(probeTelegramIdentity(ADAPTER_ID)).rejects.toThrow(/expected "telegram"/)
  })

  it("throws when the bot token is missing from the keyring", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue(null)
    await expect(probeTelegramIdentity(ADAPTER_ID)).rejects.toThrow(/Bot token/)
  })

  it("throws on HTTP 4xx", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("tg-token")
    mockHttp.mockResolvedValueOnce({ status: 401, headers: {}, body: "unauthorized" })
    await expect(probeTelegramIdentity(ADAPTER_ID)).rejects.toBeInstanceOf(TelegramWhoamiError)
  })

  it("throws when ok:false in payload", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue("tg-token")
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, description: "Unauthorized" }),
    })
    await expect(probeTelegramIdentity(ADAPTER_ID)).rejects.toThrow(/Unauthorized/)
  })
})
