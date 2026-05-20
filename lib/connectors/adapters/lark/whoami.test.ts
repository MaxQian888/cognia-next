/**
 * Coverage for `probeBotIdentity` — the Lark whoami probe.
 *
 * Mocks the Tauri-side HTTP + keyring shims and asserts:
 *   - happy-path: response shape persists into the adapter row.
 *   - error paths: missing row, wrong adapter type, missing credentials,
 *                  TAT failure, HTTP 4xx/5xx, Lark non-zero code, no open_id.
 *   - clock injection: `lastWhoamiAt` honours the optional `now` shim.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { clearTokenCache } from "./auth"
import { LarkWhoamiError, probeBotIdentity } from "./whoami"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))

const mockHttp = connectorsHttpRequest as jest.Mock
const mockKeyring = connectorsKeyringGet as jest.Mock

const APP_ID = "cli_whoami_test"
const APP_SECRET = "secret_whoami_test"
const ADAPTER_ID = "lark-whoami"

function seedRow(overrides: Partial<AdapterInstanceRow> = {}): Promise<unknown> {
  const now = 0
  return getDb().adapterInstances.put({
    id: ADAPTER_ID,
    type: "lark",
    displayName: "Lark Probe Test",
    enabled: true,
    transportMode: "webhook",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    },
    defaultMode: "auto",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
}

function makeTatResponse() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, tenant_access_token: "t-tat", expire: 7200 }),
  }
}

function makeBotInfoResponse(bot: Record<string, unknown>) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, msg: "ok", bot }),
  }
}

describe("probeBotIdentity", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    mockHttp.mockReset()
    mockKeyring.mockReset()
    clearTokenCache(APP_ID, APP_SECRET)
  })

  it("happy path — persists bot identity into the adapter row", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) => {
      if (cred === "appId") return APP_ID
      if (cred === "appSecret") return APP_SECRET
      return null
    })
    mockHttp
      .mockResolvedValueOnce(makeTatResponse()) // TAT POST
      .mockResolvedValueOnce(
        makeBotInfoResponse({
          app_name: "Cognia Bot",
          avatar_url: "https://avatars.feishu.cn/abc.png",
          open_id: "ou_real_bot",
          activate_status: 2,
        })
      )

    const result = await probeBotIdentity(ADAPTER_ID, { now: () => 1_700_000_000_000 })

    expect(result).toEqual({
      botName: "Cognia Bot",
      botAvatar: "https://avatars.feishu.cn/abc.png",
      appId: APP_ID,
      openId: "ou_real_bot",
      activateStatus: 2,
    })

    const persisted = await getDb().adapterInstances.get(ADAPTER_ID)
    expect(persisted?.lastWhoamiResult).toEqual(result)
    expect(persisted?.lastWhoamiAt).toBe(1_700_000_000_000)
  })

  it("happy path with missing avatar / status — optional fields omitted", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) => {
      if (cred === "appId") return APP_ID
      if (cred === "appSecret") return APP_SECRET
      return null
    })
    mockHttp.mockResolvedValueOnce(makeTatResponse()).mockResolvedValueOnce(
      makeBotInfoResponse({
        app_name: "Sparse Bot",
        open_id: "ou_sparse",
      })
    )

    const result = await probeBotIdentity(ADAPTER_ID)

    expect(result.botName).toBe("Sparse Bot")
    expect(result.openId).toBe("ou_sparse")
    expect(result.botAvatar).toBeUndefined()
    expect(result.activateStatus).toBeUndefined()
  })

  it("falls back to 'Unknown' when app_name is missing", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId" ? APP_ID : cred === "appSecret" ? APP_SECRET : null
    )
    mockHttp
      .mockResolvedValueOnce(makeTatResponse())
      .mockResolvedValueOnce(makeBotInfoResponse({ open_id: "ou_x" }))

    const result = await probeBotIdentity(ADAPTER_ID)
    expect(result.botName).toBe("Unknown")
  })

  it("throws LarkWhoamiError when the adapter row does not exist", async () => {
    await expect(probeBotIdentity("missing")).rejects.toThrow(LarkWhoamiError)
    await expect(probeBotIdentity("missing")).rejects.toThrow(/does not exist/)
  })

  it("throws LarkWhoamiError when the adapter is not type 'lark'", async () => {
    await seedRow({ type: "telegram" })
    await expect(probeBotIdentity(ADAPTER_ID)).rejects.toThrow(/expected "lark"/)
  })

  it("throws LarkWhoamiError when App ID is missing from keyring", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async () => null)
    await expect(probeBotIdentity(ADAPTER_ID)).rejects.toThrow(/App ID is not configured/)
  })

  it("throws LarkWhoamiError when App Secret is missing from keyring", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId" ? APP_ID : null
    )
    await expect(probeBotIdentity(ADAPTER_ID)).rejects.toThrow(/App Secret is not configured/)
  })

  it("propagates the underlying TAT error message", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId" ? APP_ID : cred === "appSecret" ? APP_SECRET : null
    )
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 99991663, msg: "invalid_app" }),
    })
    await expect(probeBotIdentity(ADAPTER_ID)).rejects.toThrow(/tenant_access_token failed/)
  })

  it("throws LarkWhoamiError on HTTP 5xx response from bot info", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId" ? APP_ID : cred === "appSecret" ? APP_SECRET : null
    )
    mockHttp
      .mockResolvedValueOnce(makeTatResponse())
      .mockResolvedValueOnce({ status: 503, headers: {}, body: "service unavailable" })

    let caught: unknown
    try {
      await probeBotIdentity(ADAPTER_ID)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LarkWhoamiError)
    expect((caught as LarkWhoamiError).httpStatus).toBe(503)
  })

  it("throws LarkWhoamiError on Lark non-zero code from bot info", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId" ? APP_ID : cred === "appSecret" ? APP_SECRET : null
    )
    mockHttp.mockResolvedValueOnce(makeTatResponse()).mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 10001, msg: "internal_error" }),
    })

    let caught: unknown
    try {
      await probeBotIdentity(ADAPTER_ID)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LarkWhoamiError)
    expect((caught as LarkWhoamiError).larkCode).toBe(10001)
  })

  it("throws when bot info response has no open_id", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId" ? APP_ID : cred === "appSecret" ? APP_SECRET : null
    )
    mockHttp
      .mockResolvedValueOnce(makeTatResponse())
      .mockResolvedValueOnce(makeBotInfoResponse({ app_name: "No-OpenId Bot" }))

    await expect(probeBotIdentity(ADAPTER_ID)).rejects.toThrow(LarkWhoamiError)
  })

  it("Date.now is used by default when no clock is injected", async () => {
    await seedRow()
    mockKeyring.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId" ? APP_ID : cred === "appSecret" ? APP_SECRET : null
    )
    mockHttp
      .mockResolvedValueOnce(makeTatResponse())
      .mockResolvedValueOnce(
        makeBotInfoResponse({ app_name: "Default-Now Bot", open_id: "ou_default" })
      )

    const before = Date.now()
    await probeBotIdentity(ADAPTER_ID)
    const after = Date.now()
    const persisted = await getDb().adapterInstances.get(ADAPTER_ID)
    expect(persisted?.lastWhoamiAt).toBeGreaterThanOrEqual(before)
    expect(persisted?.lastWhoamiAt).toBeLessThanOrEqual(after)
  })
})
