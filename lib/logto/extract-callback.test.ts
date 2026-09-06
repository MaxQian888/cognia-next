import { extractCallback } from "./extract-callback"

describe("extractCallback", () => {
  it("parses code + state from a callback URL", () => {
    expect(extractCallback("https://cb/x?code=abc&state=st")).toEqual({ code: "abc", state: "st" })
    expect(extractCallback("cognia://logto/callback?code=abc&state=st")).toEqual({
      code: "abc",
      state: "st",
    })
  })

  it("parses a URL with only a code", () => {
    expect(extractCallback("https://cb/x?code=abc")).toEqual({ code: "abc" })
  })

  it("accepts a bare code (trimmed)", () => {
    expect(extractCallback("  bare_code  ")).toEqual({ code: "bare_code" })
  })

  it("rejects empty, multi-word, and code-less URLs", () => {
    expect(extractCallback("")).toBeNull()
    expect(extractCallback("two words")).toBeNull()
    expect(extractCallback("https://cb/x?state=st")).toBeNull()
  })
})
