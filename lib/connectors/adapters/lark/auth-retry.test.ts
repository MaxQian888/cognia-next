/**
 * @jest-environment node
 */

import {
  LarkApiError,
  TAT_INVALIDATION_CODES,
  isLarkTatInvalidation,
  withTatRefresh,
} from "./auth-retry"

const mockClearTokenCache = jest.fn()

jest.mock("./auth", () => ({
  clearTokenCache: (...args: unknown[]) => mockClearTokenCache(...args),
}))

beforeEach(() => {
  mockClearTokenCache.mockClear()
})

describe("LarkApiError", () => {
  it("captures status, code and message", () => {
    const err = new LarkApiError({ status: 401, code: 99991663, message: "boom" })
    expect(err.name).toBe("LarkApiError")
    expect(err.status).toBe(401)
    expect(err.code).toBe(99991663)
    expect(err.message).toBe("boom")
  })

  it("allows null code for HTTP-layer failures without a Lark body", () => {
    const err = new LarkApiError({ status: 502, code: null, message: "bad gateway" })
    expect(err.code).toBeNull()
  })
})

describe("isLarkTatInvalidation — LarkApiError instances", () => {
  it("detects HTTP 401", () => {
    const err = new LarkApiError({ status: 401, code: null, message: "Unauthorized" })
    expect(isLarkTatInvalidation(err)).toBe(true)
  })

  it("detects each documented invalidation code", () => {
    for (const code of TAT_INVALIDATION_CODES) {
      const err = new LarkApiError({ status: 200, code, message: `code=${code}` })
      expect(isLarkTatInvalidation(err)).toBe(true)
    }
  })

  it("does not treat unrelated HTTP 5xx as TAT invalidation", () => {
    const err = new LarkApiError({ status: 500, code: null, message: "Internal Server Error" })
    expect(isLarkTatInvalidation(err)).toBe(false)
  })

  it("does not treat unrelated Lark codes as TAT invalidation", () => {
    const err = new LarkApiError({ status: 200, code: 230002, message: "rate limited" })
    expect(isLarkTatInvalidation(err)).toBe(false)
  })
})

describe("isLarkTatInvalidation — plain Error fallback", () => {
  it("recognises 401 substring from Rust upload errors", () => {
    const err = new Error("connectors_lark_upload_file failed: HTTP 401 Unauthorized")
    expect(isLarkTatInvalidation(err)).toBe(true)
  })

  it("recognises Lark code substring from Rust upload errors", () => {
    const err = new Error("Lark API error: code=99991663, msg=invalid access_token")
    expect(isLarkTatInvalidation(err)).toBe(true)
  })

  it("recognises alternate code: <num> format", () => {
    const err = new Error("Upload rejected: code: 99991668 — token expired")
    expect(isLarkTatInvalidation(err)).toBe(true)
  })

  it("does not match unrelated error messages", () => {
    expect(isLarkTatInvalidation(new Error("network unreachable"))).toBe(false)
    expect(isLarkTatInvalidation(new Error("404 Not Found"))).toBe(false)
    expect(isLarkTatInvalidation(new Error("code=2034 — chat not found"))).toBe(false)
  })

  it("does not match accidental 401 substring inside a larger number", () => {
    // "1401" should not match — regex requires word-boundary or non-digit on the right
    // and start-of-string/whitespace on the left.
    expect(isLarkTatInvalidation(new Error("got status 140199 from upstream"))).toBe(false)
  })

  it("safely handles non-Error values", () => {
    expect(isLarkTatInvalidation(null)).toBe(false)
    expect(isLarkTatInvalidation(undefined)).toBe(false)
    expect(isLarkTatInvalidation("401")).toBe(false)
    expect(isLarkTatInvalidation({ status: 401 })).toBe(false)
  })
})

describe("withTatRefresh", () => {
  const ctx = { appId: "cli_test", appSecret: "secret" }

  it("returns result on first-pass success without touching cache", async () => {
    const fn = jest.fn().mockResolvedValue("ok")
    const result = await withTatRefresh(ctx, fn)
    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
    expect(mockClearTokenCache).not.toHaveBeenCalled()
  })

  it("propagates non-TAT errors without retry", async () => {
    const err = new Error("network timeout")
    const fn = jest.fn().mockRejectedValue(err)
    await expect(withTatRefresh(ctx, fn)).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(mockClearTokenCache).not.toHaveBeenCalled()
  })

  it("clears cache and retries once on TAT invalidation", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new LarkApiError({ status: 401, code: null, message: "Unauthorized" }))
      .mockResolvedValueOnce("refreshed-ok")
    const result = await withTatRefresh(ctx, fn)
    expect(result).toBe("refreshed-ok")
    expect(fn).toHaveBeenCalledTimes(2)
    expect(mockClearTokenCache).toHaveBeenCalledWith("cli_test", "secret")
    expect(mockClearTokenCache).toHaveBeenCalledTimes(1)
  })

  it("clears cache on code=99991663 invalidation", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(
        new LarkApiError({ status: 200, code: 99991663, message: "code=99991663" })
      )
      .mockResolvedValueOnce("ok")
    await withTatRefresh(ctx, fn)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(mockClearTokenCache).toHaveBeenCalledWith("cli_test", "secret")
  })

  it("propagates the retry's failure unchanged (no third attempt)", async () => {
    const persistent = new LarkApiError({
      status: 401,
      code: null,
      message: "still unauthorized after refresh",
    })
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new LarkApiError({ status: 401, code: null, message: "first 401" }))
      .mockRejectedValueOnce(persistent)
    await expect(withTatRefresh(ctx, fn)).rejects.toBe(persistent)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(mockClearTokenCache).toHaveBeenCalledTimes(1)
  })

  it("does not call clearTokenCache for unrelated errors during retry detection", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("dns lookup failed"))
    await expect(withTatRefresh(ctx, fn)).rejects.toThrow("dns lookup failed")
    expect(mockClearTokenCache).not.toHaveBeenCalled()
  })
})
