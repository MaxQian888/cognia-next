import {
  OPENCODE_WHITELIST,
  isWhitelistedOpencodeSubProvider,
  toOpencodeZenProviderCredential,
} from "./types"

describe("OPENCODE_WHITELIST", () => {
  it("contains exactly the three known sub-providers", () => {
    expect([...OPENCODE_WHITELIST]).toEqual(["anthropic", "openai", "opencode-zen"])
  })
})

describe("isWhitelistedOpencodeSubProvider", () => {
  it("returns true for whitelist members", () => {
    expect(isWhitelistedOpencodeSubProvider("anthropic")).toBe(true)
    expect(isWhitelistedOpencodeSubProvider("openai")).toBe(true)
    expect(isWhitelistedOpencodeSubProvider("opencode-zen")).toBe(true)
  })

  it("returns false for anything else", () => {
    expect(isWhitelistedOpencodeSubProvider("google")).toBe(false)
    expect(isWhitelistedOpencodeSubProvider("opencode")).toBe(false)
    expect(isWhitelistedOpencodeSubProvider("")).toBe(false)
  })
})

describe("toOpencodeZenProviderCredential", () => {
  it("stamps the provider discriminator", () => {
    const tagged = toOpencodeZenProviderCredential({
      accessToken: "ozk",
      baseUrl: "https://zen.opencode.ai",
      storedAtMs: 1_700_000_000_000,
    })
    expect(tagged.provider).toBe("opencode-zen")
    expect(tagged).toMatchObject({
      accessToken: "ozk",
      baseUrl: "https://zen.opencode.ai",
      storedAtMs: 1_700_000_000_000,
    })
  })
})
