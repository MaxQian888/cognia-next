import { getProviderIconInfo, getProviderIconPath } from "./provider-icons"

describe("provider icon resolution", () => {
  it("prefers bundled local icons for known providers", () => {
    expect(getProviderIconPath("openai")).toBe("/icons/providers/openai.svg")
    expect(getProviderIconPath("Ollama")).toBe("/icons/providers/ollama.svg")
  })

  it("falls back to the models.dev logo id for providers without local icons", () => {
    expect(getProviderIconPath("opencode")).toBe("https://models.dev/logos/opencode.svg")
  })

  it("generates a stable fallback for unknown providers", () => {
    expect(getProviderIconInfo("AcmeAI")).toEqual({
      name: "AcmeAI",
      localIcon: "/icons/providers/acmeai.svg",
      brandColor: "#6b7280",
      hasLocalIcon: false,
    })
    expect(getProviderIconPath("AcmeAI")).toBe("https://models.dev/logos/acmeai.svg")
  })
})
