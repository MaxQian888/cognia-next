jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
}))

jest.mock("./auth", () => ({
  getTenantAccessToken: jest.fn(),
  getUserAccessToken: jest.fn(),
  clearTokenCache: jest.fn(),
  refreshUserToken: jest.fn(),
}))

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { clearTokenCache, getTenantAccessToken, getUserAccessToken } from "./auth"
import { LarkApiError } from "./auth-retry"
import { classifyScopeError, larkTenantRequest, larkUserRequest } from "./http"
import { ChatManagementScopeError } from "@/types/connectors/chat-management"

const mHttp = connectorsHttpRequest as jest.Mock
const mTat = getTenantAccessToken as jest.Mock
const mUserToken = getUserAccessToken as jest.Mock
const mClear = clearTokenCache as jest.Mock

const CREDS = { appId: "cli_x", appSecret: "sec" }

beforeEach(() => {
  jest.clearAllMocks()
  mTat.mockResolvedValue("tat-1")
  mHttp.mockResolvedValue({ status: 200, body: JSON.stringify({ code: 0, data: { ok: true } }) })
})

describe("larkTenantRequest", () => {
  it("issues a bearer tenant-token request and returns the parsed body", async () => {
    const out = await larkTenantRequest(CREDS, "POST", "/im/v1/chats?x=1", { name: "g" })
    expect(out).toEqual({ code: 0, data: { ok: true } })
    const call = mHttp.mock.calls[0][0]
    expect(call.url).toBe("https://open.feishu.cn/open-apis/im/v1/chats?x=1")
    expect(call.method).toBe("POST")
    expect(call.headers.Authorization).toBe("Bearer tat-1")
    expect(JSON.parse(call.body)).toEqual({ name: "g" })
  })

  it("supports PUT (chat update — the factory closures never did)", async () => {
    await larkTenantRequest(CREDS, "PUT", "/im/v1/chats/oc_1", { name: "n" })
    expect(mHttp.mock.calls[0][0].method).toBe("PUT")
  })

  it("retries exactly once after a token-invalidation code, clearing the cache", async () => {
    mHttp
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ code: 99991663, msg: "invalid token" }),
      })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ code: 0, data: { ok: 1 } }) })
    const out = await larkTenantRequest(CREDS, "GET", "/x")
    expect(out).toEqual({ code: 0, data: { ok: 1 } })
    expect(mClear).toHaveBeenCalledWith("cli_x", "sec")
    expect(mHttp).toHaveBeenCalledTimes(2)
  })

  it("throws LarkApiError on non-zero business codes (no retry for non-auth codes)", async () => {
    mHttp.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ code: 1248006, msg: "no perm" }),
    })
    await expect(larkTenantRequest(CREDS, "GET", "/x")).rejects.toBeInstanceOf(LarkApiError)
    expect(mHttp).toHaveBeenCalledTimes(1)
  })

  it("throws LarkApiError with the extracted code on HTTP >= 400", async () => {
    mHttp.mockResolvedValue({ status: 403, body: JSON.stringify({ code: 99991672, msg: "scope" }) })
    const err = await larkTenantRequest(CREDS, "GET", "/x").catch((e) => e)
    expect(err).toBeInstanceOf(LarkApiError)
    expect((err as LarkApiError).status).toBe(403)
    expect((err as LarkApiError).code).toBe(99991672)
  })
})

describe("larkTenantRequest — body/parse edges", () => {
  it("omits the body for body-less requests and returns null for empty responses", async () => {
    mHttp.mockResolvedValue({ status: 200, body: "" })
    const out = await larkTenantRequest(CREDS, "GET", "/im/v1/chats/oc_1")
    expect(out).toBeNull()
    expect(mHttp.mock.calls[0][0].body).toBeUndefined()
  })

  it("extracts null codes from non-JSON error bodies (HTTP >= 400)", async () => {
    mHttp.mockResolvedValue({ status: 500, body: "<html>gateway error</html>" })
    const err = await larkTenantRequest(CREDS, "GET", "/x").catch((e) => e)
    expect(err).toBeInstanceOf(LarkApiError)
    expect((err as LarkApiError).code).toBeNull()
  })

  it("ignores non-numeric code fields in error bodies", async () => {
    mHttp.mockResolvedValue({ status: 400, body: JSON.stringify({ code: "weird" }) })
    const err = await larkTenantRequest(CREDS, "GET", "/x").catch((e) => e)
    expect((err as LarkApiError).code).toBeNull()
  })
})

describe("larkUserRequest", () => {
  it("returns null when the adapter has no stored user token", async () => {
    mUserToken.mockResolvedValue(null)
    expect(await larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x")).toBeNull()
    expect(mHttp).not.toHaveBeenCalled()
  })

  it("uses the user token as the bearer when present", async () => {
    mUserToken.mockResolvedValue("user-tok")
    const out = await larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x")
    expect(out).toEqual({ code: 0, data: { ok: true } })
    expect(mHttp.mock.calls[0][0].headers.Authorization).toBe("Bearer user-tok")
  })
})

describe("classifyScopeError", () => {
  it("maps the Lark permission code family to ChatManagementScopeError", () => {
    const err = new LarkApiError({ status: 200, code: 99991672, message: "no scope" })
    const scoped = classifyScopeError(err, "im:chat:create")
    expect(scoped).toBeInstanceOf(ChatManagementScopeError)
    expect(scoped?.requiredScope).toBe("im:chat:create")
    expect(scoped?.platform).toBe("lark")
    expect(scoped?.message).toContain("im:chat:create")
  })

  it("maps bare HTTP 403 to a scope error", () => {
    const err = new LarkApiError({ status: 403, code: null, message: "forbidden" })
    expect(classifyScopeError(err, "im:chat:update")).toBeInstanceOf(ChatManagementScopeError)
  })

  it("returns null for non-permission LarkApiErrors and foreign errors", () => {
    expect(
      classifyScopeError(new LarkApiError({ status: 200, code: 230001, message: "x" }), "s")
    ).toBeNull()
    expect(classifyScopeError(new Error("boom"), "s")).toBeNull()
  })
})
