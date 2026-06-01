import type { PluginContext } from "@/types/plugin"
import { PLUGIN_ID, readApiKey, readEngineConfig, readSearchProvider, secretKey } from "./config"

function ctx(
  over: { config?: Record<string, unknown>; secrets?: Partial<PluginContext["secrets"]> } = {}
): PluginContext {
  return {
    pluginId: PLUGIN_ID,
    config: over.config ?? {},
    secrets: over.secrets,
  } as unknown as PluginContext
}

describe("secretKey", () => {
  it("namespaces by plugin id", () => {
    expect(secretKey("exa")).toBe("cognia-deep-research:exaKey")
  })
})

describe("readSearchProvider", () => {
  it("defaults to exa", () => {
    expect(readSearchProvider(ctx())).toBe("exa")
  })
  it("returns tavily when configured", () => {
    expect(readSearchProvider(ctx({ config: { searchProvider: "tavily" } }))).toBe("tavily")
  })
  it("ignores unknown providers", () => {
    expect(readSearchProvider(ctx({ config: { searchProvider: "bing" } }))).toBe("exa")
  })
})

describe("readApiKey", () => {
  it("prefers the secure keyring", async () => {
    const secrets = { get: jest.fn(async () => "secret-key") }
    expect(await readApiKey(ctx({ secrets }), "exa")).toBe("secret-key")
    expect(secrets.get).toHaveBeenCalledWith("cognia-deep-research:exaKey")
  })
  it("falls back to plain config when no secret is set", async () => {
    const secrets = { get: jest.fn(async () => null) }
    expect(await readApiKey(ctx({ secrets, config: { exaApiKey: "cfg-key" } }), "exa")).toBe(
      "cfg-key"
    )
  })
  it("falls back to config when the keyring throws", async () => {
    const secrets = {
      get: jest.fn(async () => {
        throw new Error("no keyring")
      }),
    }
    expect(await readApiKey(ctx({ secrets, config: { tavilyApiKey: "t" } }), "tavily")).toBe("t")
  })
  it("returns null when no key is available anywhere", async () => {
    expect(await readApiKey(ctx(), "exa")).toBeNull()
  })
})

describe("readEngineConfig", () => {
  it("picks valid positive numbers and locale, ignoring junk", () => {
    const out = readEngineConfig(
      ctx({
        config: {
          tokenBudget: 50000,
          maxSteps: 0,
          readTopK: 2,
          searchResultsPerQuery: -1,
          locale: "zh-CN",
        },
      })
    )
    expect(out).toEqual({ tokenBudget: 50000, readTopK: 2, locale: "zh-CN" })
  })
  it("returns an empty object when nothing is configured", () => {
    expect(readEngineConfig(ctx())).toEqual({})
  })
})
