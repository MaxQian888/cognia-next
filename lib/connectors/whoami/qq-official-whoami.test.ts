/** @jest-environment jsdom */
/**
 * Coverage for `probeQQOfficialIdentity`.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getQQAccessToken } from "@/lib/connectors/adapters/qq-official/auth"
import { probeQQOfficialIdentity, QQOfficialWhoamiError } from "./qq-official-whoami"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))

jest.mock("@/lib/connectors/adapters/qq-official/auth", () => ({
  QQ_API_BASE: "https://api.sgroup.qq.com",
  qqAuthHeaders: (token: string) => ({
    Authorization: `QQBot ${token}`,
    "Content-Type": "application/json",
  }),
  getQQAccessToken: jest.fn(),
}))

const mockHttp = connectorsHttpRequest as jest.Mock
const mockKeyring = connectorsKeyringGet as jest.Mock
const mockGetToken = getQQAccessToken as jest.Mock

const ADAPTER_ID = "qq-1"

function seedRow(overrides: Partial<AdapterInstanceRow> = {}) {
  return getDb().adapterInstances.put({
    id: ADAPTER_ID,
    type: "qq-official",
    displayName: "QQ",
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
    ...overrides,
  })
}

function usersMeOk(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      id: "bot-open-id",
      username: "CogniaQQ",
      avatar: "https://q.qlogo.cn/a.png",
      ...overrides,
    }),
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockHttp.mockReset()
  mockKeyring.mockReset()
  mockGetToken.mockReset()
  mockKeyring.mockImplementation(async (_id: string, name: string) =>
    name === "appId" ? "app-1" : "secret-1"
  )
  mockGetToken.mockResolvedValue("ACCESS")
})

describe("probeQQOfficialIdentity", () => {
  it("happy path calls /users/@me with the QQBot token and persists the result", async () => {
    await seedRow()
    mockHttp.mockResolvedValueOnce(usersMeOk())
    const result = await probeQQOfficialIdentity(ADAPTER_ID, { now: () => 1_700 })
    expect(result).toEqual({
      botName: "CogniaQQ",
      botAvatar: "https://q.qlogo.cn/a.png",
      appId: "app-1",
      openId: "bot-open-id",
    })
    expect(mockGetToken).toHaveBeenCalledWith("app-1", "secret-1")
    expect(mockHttp).toHaveBeenCalledWith({
      url: "https://api.sgroup.qq.com/users/@me",
      method: "GET",
      headers: { Authorization: "QQBot ACCESS", "Content-Type": "application/json" },
    })
    const row = await getDb().adapterInstances.get(ADAPTER_ID)
    expect(row?.lastWhoamiResult?.botName).toBe("CogniaQQ")
    expect(row?.lastWhoamiAt).toBe(1_700)
  })

  it("falls back to a bot-<id> name when username is missing", async () => {
    await seedRow()
    mockHttp.mockResolvedValueOnce(usersMeOk({ username: undefined, avatar: undefined }))
    const result = await probeQQOfficialIdentity(ADAPTER_ID)
    expect(result.botName).toBe("bot-bot-open-id")
    expect(result.botAvatar).toBeUndefined()
  })

  it("throws when the row is missing", async () => {
    await expect(probeQQOfficialIdentity("ghost")).rejects.toThrow(/does not exist/)
  })

  it("throws when the row is the wrong type", async () => {
    await seedRow({ type: "telegram" })
    await expect(probeQQOfficialIdentity(ADAPTER_ID)).rejects.toThrow(/expected "qq-official"/)
  })

  it("throws when appId or clientSecret is missing from the keyring", async () => {
    await seedRow()
    mockKeyring.mockResolvedValue(null)
    await expect(probeQQOfficialIdentity(ADAPTER_ID)).rejects.toThrow(/not configured/)
  })

  it("wraps token mint failures in QQOfficialWhoamiError", async () => {
    await seedRow()
    mockGetToken.mockRejectedValue(new Error("QQ getAppAccessToken failed: bad secret"))
    await expect(probeQQOfficialIdentity(ADAPTER_ID)).rejects.toBeInstanceOf(QQOfficialWhoamiError)
    await expect(probeQQOfficialIdentity(ADAPTER_ID)).rejects.toThrow(/bad secret/)
  })

  it("throws on HTTP 4xx with the platform message", async () => {
    await seedRow()
    mockHttp.mockResolvedValue({
      status: 401,
      headers: {},
      body: JSON.stringify({ message: "invalid token" }),
    })
    await expect(probeQQOfficialIdentity(ADAPTER_ID)).rejects.toThrow(/invalid token/)
  })

  it("throws on a non-JSON body", async () => {
    await seedRow()
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: "<html>oops</html>" })
    await expect(probeQQOfficialIdentity(ADAPTER_ID)).rejects.toThrow(/non-JSON/)
  })

  it("throws when the payload has no id", async () => {
    await seedRow()
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({}) })
    await expect(probeQQOfficialIdentity(ADAPTER_ID)).rejects.toThrow(/\/users\/@me failed/)
  })
})
