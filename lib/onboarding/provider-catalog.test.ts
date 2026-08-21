import {
  groupOnboardingProviders,
  initialProviderDraft,
  listOnboardingProviders,
  onboardingProviderOption,
} from "./provider-catalog"

describe("listOnboardingProviders", () => {
  it("covers the whole built-in catalog, not a shortlist", () => {
    const ids = listOnboardingProviders().map((o) => o.id)
    // The three subscription cards cover these; everyone else had no first-run
    // path at all before this list existed.
    for (const id of ["openai", "google", "deepseek", "openrouter", "ollama", "bedrock"]) {
      expect(ids).toContain(id)
    }
  })

  it("carries the Anthropic-compatible endpoints as ordinary catalog entries", () => {
    // Kimi / GLM / MiniMax "(Claude)" rows are how a user reaches an
    // Anthropic-compatible base URL — no free-text endpoint field needed.
    const ids = listOnboardingProviders().map((o) => o.id)
    expect(ids).toContain("kimi-anthropic")
    expect(ids).toContain("glm-anthropic")
  })
})

describe("onboardingProviderOption", () => {
  it("reports a cloud provider as needing a key and no base URL", () => {
    const openai = onboardingProviderOption("openai")
    expect(openai).toMatchObject({ requiresCredential: true, isLocal: false })
    expect(openai?.dashboardUrl).toBeTruthy()
  })

  it("reports a local server as needing no key, prefilled with its port", () => {
    const ollama = onboardingProviderOption("ollama")
    expect(ollama).toMatchObject({ requiresCredential: false, isLocal: true, category: "local" })
    expect(ollama?.defaultBaseUrl).toContain("11434")
  })

  it("returns nothing for an unknown id rather than a placeholder row", () => {
    expect(onboardingProviderOption("not-a-provider")).toBeUndefined()
  })
})

describe("groupOnboardingProviders", () => {
  const groups = groupOnboardingProviders()

  it("puts flagships first and local second", () => {
    // Local needs no account anywhere and is the easiest to miss in a list of
    // this length.
    expect(groups[0]?.category).toBe("flagship")
    expect(groups[1]?.category).toBe("local")
  })

  it("drops empty categories instead of rendering bare headings", () => {
    expect(groups.every((g) => g.options.length > 0)).toBe(true)
  })

  it("alphabetises within a group", () => {
    for (const group of groups) {
      const names = group.options.map((o) => o.name)
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    }
  })

  it("loses nothing from the flat list", () => {
    const flat = listOnboardingProviders()
    expect(groups.reduce((n, g) => n + g.options.length, 0)).toBe(flat.length)
  })
})

describe("initialProviderDraft", () => {
  it("prefills a local server's base URL so the form is one field shorter", () => {
    const ollama = onboardingProviderOption("ollama")!
    expect(initialProviderDraft(ollama)).toEqual({ apiKey: "", baseURL: ollama.defaultBaseUrl })
  })

  it("starts blank for a cloud provider that supplies its own host", () => {
    const anthropic = onboardingProviderOption("anthropic")!
    expect(initialProviderDraft(anthropic).apiKey).toBe("")
  })
})
