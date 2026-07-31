import { collectProviderOptions, KNOWN_PROVIDERS } from "./provider-options"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

const base: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/w" }

describe("collectProviderOptions", () => {
  it("lists the active provider first, then configured, then the catalog", () => {
    const cfg: ResolvedConfig = {
      ...base,
      provider: "openai",
      providers: { openai: { apiKey: "k" }, customcorp: { apiKey: "k2", protocol: "openai" } },
    }
    const ids = collectProviderOptions(cfg).map((o) => o.id)
    expect(ids[0]).toBe("openai")
    expect(ids).toContain("customcorp")
    // Catalog providers are still present and de-duplicated.
    for (const known of KNOWN_PROVIDERS) expect(ids).toContain(known)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("includes the subscription agents opencode and opencode-go", () => {
    const ids = collectProviderOptions(base).map((o) => o.id)
    expect(ids).toContain("opencode")
    expect(ids).toContain("opencode-go")
  })

  it("stays in lock-step with the shared catalog (no hand-kept subset)", () => {
    const ids = collectProviderOptions(base).map((o) => o.id)
    // Providers that exist in the GUI catalog but were missing from the old
    // hardcoded CLI list must now be selectable.
    for (const id of ["zhipu", "minimax", "xai", "ollama", "togetherai"]) {
      expect(ids).toContain(id)
    }
  })

  it("carries the catalog display name for each provider", () => {
    const byId = Object.fromEntries(collectProviderOptions(base).map((o) => [o.id, o]))
    expect(byId.anthropic?.name).toBe("Anthropic")
    expect(byId.openai?.name).toBe("OpenAI")
  })

  it("falls back to the id as name for an unknown configured provider", () => {
    const cfg: ResolvedConfig = { ...base, providers: { customcorp: { apiKey: "k" } } }
    const opt = collectProviderOptions(cfg).find((o) => o.id === "customcorp")
    expect(opt?.name).toBe("customcorp")
  })

  it("marks an opencode-go subscription token as configured", () => {
    const cfg: ResolvedConfig = {
      ...base,
      providers: { "opencode-go": { authToken: "sub" } },
    }
    const opt = collectProviderOptions(cfg).find((o) => o.id === "opencode-go")
    expect(opt).toMatchObject({ configured: true, auth: "subscription" })
  })

  it("annotates each provider's auth status + configured flag", () => {
    const cfg: ResolvedConfig = {
      ...base,
      provider: "anthropic",
      providers: { anthropic: { authToken: "tok" }, openai: { apiKey: "k" } },
    }
    const byId = Object.fromEntries(collectProviderOptions(cfg).map((o) => [o.id, o]))
    expect(byId.anthropic).toMatchObject({ configured: true, auth: "subscription" })
    expect(byId.openai).toMatchObject({ configured: true, auth: "api key" })
    expect(byId.google).toMatchObject({ configured: false, auth: "no credential" })
  })

  it("flags whether a provider authenticates with a metered API key", () => {
    const byId = Object.fromEntries(collectProviderOptions(base).map((o) => [o.id, o]))
    // Metered providers require a key; local runtimes / OAuth agents don't.
    expect(byId.openai?.requiresKey).toBe(true)
    expect(byId.anthropic?.requiresKey).toBe(true)
    expect(byId.ollama?.requiresKey).toBe(false)
  })

  it("defaults an unknown configured provider to requiring a key", () => {
    const cfg: ResolvedConfig = { ...base, providers: { customcorp: { apiKey: "k" } } }
    const opt = collectProviderOptions(cfg).find((o) => o.id === "customcorp")
    // Not in the catalog → assume it needs a credential rather than switch blind.
    expect(opt?.requiresKey).toBe(true)
    expect(opt?.keyUrl).toBeUndefined()
  })

  it("surfaces the catalog's key-source URL when the provider has one", () => {
    const byId = Object.fromEntries(collectProviderOptions(base).map((o) => [o.id, o]))
    // zhipu carries a dashboard URL in the catalog; openai has none, so its
    // keyUrl comes directly from the catalog rather than being fabricated.
    expect(byId.zhipu?.keyUrl).toBe("https://open.bigmodel.cn/usercenter/apikeys")
    expect(byId.openai?.keyUrl).toBe("https://platform.openai.com/api-keys")
  })
})
