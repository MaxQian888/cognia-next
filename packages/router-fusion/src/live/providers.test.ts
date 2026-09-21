import {
  credentialEnvName,
  listLiveProviders,
  providerOfDeployment,
  restrictToProviders,
  unconfirmedDeployments,
  type ProviderSettingsLike,
} from "./providers"

const SETTINGS: ProviderSettingsLike = {
  providerSettings: {
    openai: { providerId: "openai", enabled: true, defaultModel: "gpt-4o-mini" },
    deepseek: { providerId: "deepseek", enabled: false, defaultModel: "deepseek-chat" },
    "my-proxy": { providerId: "my-proxy", enabled: true, defaultModel: "shadow" },
  },
  customProviders: [
    { id: "my-proxy", enabled: true, customName: "My proxy", apiKey: "" },
    { id: "lab", enabled: false, name: "Lab" },
  ],
}

describe("credentialEnvName", () => {
  it("uses the harness's own prefix and an upper-case provider id", () => {
    expect(credentialEnvName("anthropic")).toBe("COGNIA_LIVE_SMOKE_KEY_ANTHROPIC")
    expect(credentialEnvName("my-proxy.v2")).toBe("COGNIA_LIVE_SMOKE_KEY_MY_PROXY_V2")
  })
})

describe("listLiveProviders", () => {
  it("lists configured, custom and implicit providers with their credential status", () => {
    const { providers } = listLiveProviders(
      SETTINGS,
      { COGNIA_LIVE_SMOKE_KEY_OPENAI: "sk-x", OPENAI_API_KEY: "ignored" },
      null
    )
    expect(providers.map((p) => [p.id, p.kind, p.enabled, p.credentialFound, p.selected])).toEqual([
      ["anthropic", "builtin", true, false, false],
      ["deepseek", "builtin", false, false, false],
      ["lab", "custom", false, false, false],
      ["my-proxy", "custom", true, false, false],
      ["openai", "builtin", true, true, true],
    ])
    expect(providers.find((p) => p.id === "my-proxy")?.name).toBe("My proxy")
  })

  it("never picks up a key under a conventional name", () => {
    const { providers } = listLiveProviders(SETTINGS, { ANTHROPIC_API_KEY: "sk-ant" }, null)
    expect(providers.find((p) => p.id === "anthropic")?.credentialFound).toBe(false)
  })

  it("selects exactly the requested providers that are enabled, and reports unknown ones", () => {
    const { providers, unknownRequested } = listLiveProviders(SETTINGS, {}, [
      "anthropic",
      "deepseek",
      "nope",
    ])
    expect(providers.filter((p) => p.selected).map((p) => p.id)).toEqual(["anthropic"])
    expect(unknownRequested).toEqual(["nope"])
  })
})

describe("restrictToProviders", () => {
  const env = { COGNIA_LIVE_SMOKE_KEY_OPENAI: "sk-openai", COGNIA_LIVE_SMOKE_KEY_MY_PROXY: "k" }

  it("switches every unconfirmed provider off and gives confirmed ones their key", () => {
    const restricted = restrictToProviders(SETTINGS, {
      selected: ["openai", "my-proxy"],
      env,
      knownBuiltinIds: ["openai", "groq"],
    })
    expect(restricted.providerSettings?.openai).toMatchObject({
      enabled: true,
      apiKey: "sk-openai",
      defaultModel: "gpt-4o-mini",
    })
    // A catalog provider with no row, and the implicit anthropic, get a disabled row.
    expect(restricted.providerSettings?.groq).toEqual({
      providerId: "groq",
      defaultModel: "",
      enabled: false,
    })
    expect(restricted.providerSettings?.anthropic?.enabled).toBe(false)
    expect(restricted.providerSettings?.deepseek?.enabled).toBe(false)
    // A confirmed custom provider keeps its own row as the source of truth.
    expect(restricted.providerSettings?.["my-proxy"]).toEqual(
      SETTINGS.providerSettings?.["my-proxy"]
    )
    expect(restricted.customProviders).toEqual([
      { id: "my-proxy", enabled: true, customName: "My proxy", apiKey: "k" },
      { id: "lab", enabled: false, name: "Lab" },
    ])
  })

  it("switches an unconfirmed custom provider off in both of its rows", () => {
    const restricted = restrictToProviders(SETTINGS, {
      selected: ["openai"],
      env,
      knownBuiltinIds: [],
    })
    expect(restricted.providerSettings?.["my-proxy"]?.enabled).toBe(false)
    expect(restricted.providerSettings?.lab).toEqual({
      providerId: "lab",
      defaultModel: "",
      enabled: false,
    })
    expect(restricted.customProviders?.every((row) => row.enabled === false)).toBe(true)
  })

  it("never writes to the settings it was given", () => {
    const before = structuredClone(SETTINGS)
    restrictToProviders(SETTINGS, { selected: ["openai"], env, knownBuiltinIds: ["groq"] })
    expect(SETTINGS).toEqual(before)
  })
})

describe("deployment fence", () => {
  it("names the provider of a deployment id", () => {
    expect(providerOfDeployment("openai::gpt-4o")).toBe("openai")
    expect(providerOfDeployment("fake::mock/economy-v1")).toBe("fake")
    expect(providerOfDeployment("bare")).toBe("bare")
  })

  it("lists pinned deployments outside the confirmed providers", () => {
    expect(
      unconfirmedDeployments(
        { solver: "openai::gpt-4o", judge: "anthropic::claude", reviewer: "anthropic::claude" },
        ["openai"]
      )
    ).toEqual(["anthropic::claude"])
    expect(unconfirmedDeployments({ solver: "openai::gpt-4o" }, ["openai"])).toEqual([])
  })
})
