import { getProviderDisplayName, getProviderIconInfo } from "./icons"

describe("getProviderDisplayName", () => {
  it("names a provider from its icon entry", () => {
    expect(getProviderDisplayName("google")).toBe("Google AI")
    expect(getProviderDisplayName("OpenAI")).toBe("OpenAI")
  })

  // The video providers have no icon entry; a raw id in a picker reads as a bug.
  it("falls back to the built-in provider catalog's name", () => {
    expect(getProviderDisplayName("replicate")).toBe("Replicate")
    expect(getProviderDisplayName("fal")).toBe("Fal AI")
    expect(getProviderDisplayName("volcengine")).toBe("Volcengine Doubao")
    expect(getProviderIconInfo("qwen").hasLocalIcon).toBe(false)
  })

  it("keeps the id of a provider it does not know", () => {
    expect(getProviderDisplayName("my-gateway")).toBe("my-gateway")
  })
})
