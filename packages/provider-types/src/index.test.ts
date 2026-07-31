import {
  DEFAULT_AUTO_ROUTER_SETTINGS,
  LOCAL_PROVIDER_PORTS,
  PROVIDERS,
  getBuiltInProviderCatalogEntry,
  getProviderConfig,
  isLocalProviderName,
} from "."

describe("@cognia/provider-types barrel", () => {
  it("exports the stable provider, local-provider, catalog, and router surfaces", () => {
    expect(getProviderConfig("openai")).toBe(PROVIDERS.openai)
    expect(getBuiltInProviderCatalogEntry("openai")?.id).toBe("openai")
    expect(isLocalProviderName("ollama")).toBe(true)
    expect(LOCAL_PROVIDER_PORTS.ollama).toBe(11434)
    expect(DEFAULT_AUTO_ROUTER_SETTINGS.strategy).toBe("reliability")
  })
})
