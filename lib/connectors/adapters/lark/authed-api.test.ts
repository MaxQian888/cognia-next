jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))
jest.mock("./auth", () => ({
  getUserAccessToken: jest.fn(),
  getTenantAccessToken: jest.fn(),
  refreshUserToken: jest.fn(),
  clearTokenCache: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet, type TauriHttpRequest } from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken, getUserAccessToken, refreshUserToken } from "./auth"
import { LarkApiError } from "./auth-retry"
import { LARK_API_BASE, LarkAccessError, withLarkAuthedApi } from "./authed-api"

const isTauriMock = isTauri as jest.Mock
const getAdapterInstanceMock = getAdapterInstance as jest.Mock
const keyringGetMock = connectorsKeyringGet as jest.Mock
const getUserAccessTokenMock = getUserAccessToken as jest.Mock
const getTenantAccessTokenMock = getTenantAccessToken as jest.Mock
const refreshUserTokenMock = refreshUserToken as jest.Mock

const ADAPTER = "cai_authed"

function ok(data: unknown) {
  return {
    status: 200,
    headers: {} as Record<string, string>,
    body: JSON.stringify({ code: 0, data }),
  }
}

function makeHttp(
  responses: Array<{ status: number; headers?: Record<string, string>; body: string }>
) {
  const calls: TauriHttpRequest[] = []
  const impl = jest.fn(async (req: TauriHttpRequest) => {
    calls.push(req)
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request ${req.url}`)
    return { headers: {}, ...next }
  })
  return { impl, calls }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  getAdapterInstanceMock.mockResolvedValue({
    id: ADAPTER,
    type: "lark",
    enabled: true,
    displayName: "Acme Feishu",
  })
  keyringGetMock.mockImplementation(async (_id: string, key: string) =>
    key === "appId" ? "cli_app" : "secret"
  )
  getUserAccessTokenMock.mockResolvedValue(null)
  getTenantAccessTokenMock.mockResolvedValue("tat-1")
})

describe("withLarkAuthedApi — pre-flight", () => {
  it("refuses outside Tauri when no transport is injected", async () => {
    isTauriMock.mockReturnValue(false)
    await expect(withLarkAuthedApi({ adapterId: ADAPTER }, async () => "x")).rejects.toMatchObject({
      name: "LarkAccessError",
      code: "browserUnsupported",
    })
    expect(getAdapterInstanceMock).not.toHaveBeenCalled()
  })

  it("accepts an injected transport outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { impl } = makeHttp([ok({ ok: true })])
    const out = await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get<{ ok: boolean }>("/open-apis/ping")
    )
    expect(out).toEqual({ ok: true })
  })

  it.each([
    ["missing", null],
    ["disabled", { id: ADAPTER, type: "lark", enabled: false, displayName: "x" }],
    ["wrong type", { id: ADAPTER, type: "slack", enabled: true, displayName: "x" }],
  ])("throws noAccount for a %s adapter", async (_label, row) => {
    getAdapterInstanceMock.mockResolvedValue(row)
    const { impl } = makeHttp([])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, async () => "x")
    ).rejects.toMatchObject({ code: "noAccount" })
  })

  it("throws notAuthorized carrying the account name when credentials are missing", async () => {
    keyringGetMock.mockResolvedValue(null)
    const { impl } = makeHttp([])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, async () => "x")
    ).rejects.toMatchObject({ code: "notAuthorized", account: "Acme Feishu" })
  })
})

describe("withLarkAuthedApi — identity order", () => {
  it("prefers the connected user so document ACLs apply as that user", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-1")
    const { impl, calls } = makeHttp([ok({ n: 1 })])
    await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get("/open-apis/x")
    )
    expect(calls[0].headers?.Authorization).toBe("Bearer uat-1")
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })

  it("falls back to the bot identity when no user is connected", async () => {
    const { impl, calls } = makeHttp([ok({ n: 1 })])
    await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get("/open-apis/x")
    )
    expect(calls[0].headers?.Authorization).toBe("Bearer tat-1")
  })

  it("falls back to the bot after the user token stays invalid through a refresh", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-dead")
    refreshUserTokenMock.mockResolvedValue("uat-dead")
    const { impl, calls } = makeHttp([
      { status: 401, body: JSON.stringify({ code: 99991663, msg: "invalid" }) },
      { status: 401, body: JSON.stringify({ code: 99991663, msg: "invalid" }) },
      ok({ n: 2 }),
    ])
    const out = await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get<{ n: number }>("/open-apis/x")
    )
    expect(out).toEqual({ n: 2 })
    expect(calls.at(-1)?.headers?.Authorization).toBe("Bearer tat-1")
  })

  it("does not fall back to the bot on an unrelated user-identity failure", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-1")
    const { impl } = makeHttp([{ status: 403, body: JSON.stringify({ code: 1254302, msg: "no" }) }])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) => api.get("/open-apis/x"))
    ).rejects.toBeInstanceOf(LarkApiError)
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })
})

describe("withLarkAuthedApi — requireUserIdentity", () => {
  it("refuses up front when no user is connected", async () => {
    const { impl } = makeHttp([])
    await expect(
      withLarkAuthedApi(
        { adapterId: ADAPTER, httpImpl: impl, requireUserIdentity: true },
        async () => "x"
      )
    ).rejects.toMatchObject({ code: "notAuthorized", account: "Acme Feishu" })
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })

  it("never silently downgrades to the bot after the user token dies", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-dead")
    refreshUserTokenMock.mockResolvedValue("uat-dead")
    const { impl } = makeHttp([
      { status: 401, body: JSON.stringify({ code: 99991663, msg: "invalid" }) },
      { status: 401, body: JSON.stringify({ code: 99991663, msg: "invalid" }) },
    ])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl, requireUserIdentity: true }, (api) =>
        api.get("/open-apis/x")
      )
    ).rejects.toBeInstanceOf(LarkApiError)
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })

  it("uses the user identity normally when one is connected", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-1")
    const { impl, calls } = makeHttp([ok({ n: 1 })])
    await withLarkAuthedApi(
      { adapterId: ADAPTER, httpImpl: impl, requireUserIdentity: true },
      (api) => api.get("/open-apis/x")
    )
    expect(calls[0].headers?.Authorization).toBe("Bearer uat-1")
  })
})

describe("withLarkAuthedApi — requests", () => {
  it("builds absolute open.feishu.cn URLs and sends JSON headers", async () => {
    const { impl, calls } = makeHttp([ok({})])
    await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get("/open-apis/docx/v1/documents/tok")
    )
    expect(calls[0].url).toBe(`${LARK_API_BASE}/open-apis/docx/v1/documents/tok`)
    expect(calls[0].method).toBe("GET")
    expect(calls[0].headers?.["Content-Type"]).toBe("application/json; charset=utf-8")
    expect(calls[0].body).toBeUndefined()
  })

  it("serializes POST bodies", async () => {
    const { impl, calls } = makeHttp([ok({})])
    await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.post("/open-apis/bitable/v1/apps/a/tables/t/records/search", { page_size: 3 })
    )
    expect(calls[0].method).toBe("POST")
    expect(calls[0].body).toBe(JSON.stringify({ page_size: 3 }))
  })

  it("raises LarkApiError on a non-zero business code even at HTTP 200", async () => {
    const { impl } = makeHttp([
      { status: 200, body: JSON.stringify({ code: 1254005, msg: "gone" }) },
    ])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) => api.get("/open-apis/x"))
    ).rejects.toMatchObject({ name: "LarkApiError", code: 1254005, status: 200 })
  })

  it("raises LarkApiError with the body snippet when the payload is not JSON", async () => {
    const { impl } = makeHttp([{ status: 502, body: "<html>bad gateway</html>" }])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) => api.get("/open-apis/x"))
    ).rejects.toMatchObject({ code: null, status: 502 })
  })

  it("hands the resolved account to the callback", async () => {
    const { impl } = makeHttp([ok({})])
    const seen = await withLarkAuthedApi(
      { adapterId: ADAPTER, httpImpl: impl },
      async (_api, acct) => acct
    )
    expect(seen).toEqual({ adapterId: ADAPTER, displayName: "Acme Feishu" })
  })

  it("routes failures through mapError when one is supplied", async () => {
    const { impl } = makeHttp([{ status: 500, body: JSON.stringify({ code: 1, msg: "boom" }) }])
    const mapError = jest.fn((_err: unknown, account: string) => new Error(`mapped:${account}`))
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl, mapError }, (api) =>
        api.get("/open-apis/x")
      )
    ).rejects.toThrow("mapped:Acme Feishu")
    expect(mapError).toHaveBeenCalledTimes(1)
  })
})

describe("LarkAccessError", () => {
  it("keeps the code and account addressable", () => {
    const err = new LarkAccessError("notAuthorized", "Acme")
    expect(err.code).toBe("notAuthorized")
    expect(err.account).toBe("Acme")
    expect(err.message).toContain("Acme")
  })
})
