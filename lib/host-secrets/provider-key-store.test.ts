import {
  hostProviderKey,
  hostProviderKeyCount,
  overlayHostProviderKeys,
  replaceHostProviderKeys,
} from "./provider-key-store"

afterEach(() => replaceHostProviderKeys([]))

describe("host provider key store", () => {
  it("fills providers that have no key and leaves a configured key alone", () => {
    replaceHostProviderKeys([
      ["deepseek", "sk-host"],
      ["openai", "sk-host-openai"],
      ["moonshot", "sk-host-moon"],
    ])
    const providers = {
      deepseek: { enabled: true, apiKey: "" },
      openai: { enabled: true, apiKey: "sk-own" },
    }
    const overlaid = overlayHostProviderKeys(providers)
    expect(overlaid.deepseek).toEqual({ enabled: true, apiKey: "sk-host" })
    expect(overlaid.openai).toEqual({ enabled: true, apiKey: "sk-own" })
    // A provider the settings never listed is added, keyed only.
    expect(overlaid.moonshot).toEqual({ apiKey: "sk-host-moon" })
    // The input is never mutated.
    expect(providers.deepseek.apiKey).toBe("")
  })

  it("returns the same object when there is nothing to fill", () => {
    const providers = { openai: { apiKey: "sk-own" } }
    expect(overlayHostProviderKeys(providers)).toBe(providers)
    replaceHostProviderKeys([["openai", "sk-host"]])
    expect(overlayHostProviderKeys(providers)).toBe(providers)
  })

  it("drops blank keys and replaces rather than merges", () => {
    replaceHostProviderKeys([
      ["a", "k"],
      ["b", "  "],
      ["", "k"],
    ])
    expect(hostProviderKeyCount()).toBe(1)
    expect(hostProviderKey("a")).toBe("k")
    replaceHostProviderKeys([["c", "k"]])
    expect(hostProviderKey("a")).toBeUndefined()
    expect(hostProviderKey("c")).toBe("k")
  })
})
