import type { BalanceQuery } from "@/types/subscription"

import { bearer, errorSnapshot, parseJsonObject, toNum, trimBase } from "./_shared"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "deepseek",
  baseUrl: "https://x/v1",
  token: "t",
}

describe("balance adapter shared helpers", () => {
  it("bearer builds an Authorization + Accept header", () => {
    expect(bearer("abc")).toEqual({ Authorization: "Bearer abc", Accept: "application/json" })
  })

  it("trimBase strips trailing slashes", () => {
    expect(trimBase("https://x/")).toBe("https://x")
    expect(trimBase("https://x///")).toBe("https://x")
    expect(trimBase("https://x")).toBe("https://x")
  })

  it("toNum coerces numbers and numeric strings", () => {
    expect(toNum(12.5)).toBe(12.5)
    expect(toNum("  88.88 ")).toBe(88.88)
    expect(toNum("nope")).toBeUndefined()
    expect(toNum(Infinity)).toBeUndefined()
    expect(toNum(null)).toBeUndefined()
    expect(toNum({})).toBeUndefined()
  })

  it("parseJsonObject returns objects only", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject("[1,2]")).toBeNull()
    expect(parseJsonObject("42")).toBeNull()
    expect(parseJsonObject("bad")).toBeNull()
  })

  it("errorSnapshot carries the message + raw", () => {
    const snap = errorSnapshot(Q, "credit", "boom", { a: 1 })
    expect(snap.error).toBe("boom")
    expect(snap.kind).toBe("credit")
    expect(snap.raw).toEqual({ a: 1 })
    expect(snap.accountId).toBe("acc-1")
    expect(typeof snap.fetchedAt).toBe("number")
  })

  it("errorSnapshot defaults raw to an empty object", () => {
    expect(errorSnapshot(Q, "credit", "x").raw).toEqual({})
  })
})
