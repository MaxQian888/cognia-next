import { BALANCE_ADAPTERS, findBalanceAdapter } from "./registry"
import {
  registerBalanceAdapter,
  __resetBalanceAdaptersForTesting,
} from "@/lib/plugin/registries/balance-adapter-registry"
import type { PluginBalanceAdapterDef } from "@/types/plugin/plugin-balance-adapter"

function fakeAdapter(id: string, key: string, host?: string): PluginBalanceAdapterDef {
  return {
    id,
    key,
    name: id,
    matches: (q) => q.providerKey === key || (host != null && Boolean(q.baseUrl?.includes(host))),
    request: (q) => ({ url: `https://example/${q.providerKey}`, headers: {} }),
    parse: () => ({ fetchedAt: 0, providerKey: key, accountId: "a", kind: "credit", raw: {} }),
  }
}

describe("balance registry", () => {
  it("lists only documented adapters", () => {
    expect(BALANCE_ADAPTERS.map((a) => a.key).sort()).toEqual([
      "302ai",
      "deepinfra",
      "deepseek",
      "moonshot",
      "novita",
      "openrouter",
      "ppio",
      "siliconflow",
    ])
  })

  it("resolves by providerKey first", () => {
    expect(findBalanceAdapter({ providerKey: "deepseek" })?.key).toBe("deepseek")
    expect(findBalanceAdapter({ providerKey: "openrouter" })?.key).toBe("openrouter")
    expect(findBalanceAdapter({ providerKey: "moonshot" })?.key).toBe("moonshot")
    expect(findBalanceAdapter({ providerKey: "siliconflow" })?.key).toBe("siliconflow")
  })

  it("falls back to baseUrl host when providerKey doesn't match", () => {
    expect(
      findBalanceAdapter({ providerKey: "custom", baseUrl: "https://api.deepseek.com/v1" })?.key
    ).toBe("deepseek")
  })

  it("matches by baseUrl when no providerKey is given", () => {
    expect(findBalanceAdapter({ baseUrl: "https://openrouter.ai/api/v1" })?.key).toBe("openrouter")
  })

  it("returns undefined when nothing matches", () => {
    expect(findBalanceAdapter({ providerKey: "groq" })).toBeUndefined()
    expect(findBalanceAdapter({ baseUrl: "https://api.groq.com/openai/v1" })).toBeUndefined()
    expect(findBalanceAdapter({})).toBeUndefined()
  })
})

describe("balance registry — plugin overlay adapters", () => {
  afterEach(() => __resetBalanceAdaptersForTesting())

  it("resolves a plugin adapter for a providerKey no built-in covers", () => {
    registerBalanceAdapter("p:groq", fakeAdapter("p:groq", "groq"), { pluginId: "p" })
    expect(findBalanceAdapter({ providerKey: "groq" })?.key).toBe("groq")
  })

  it("lets a plugin adapter override a built-in for the same providerKey", () => {
    const override = fakeAdapter("p:ds", "deepseek")
    registerBalanceAdapter("p:ds", override, { pluginId: "p" })
    expect(findBalanceAdapter({ providerKey: "deepseek" })).toBe(override)
  })

  it("matches a plugin adapter by baseUrl host", () => {
    registerBalanceAdapter("p:host", fakeAdapter("p:host", "myco", "myco.example"), {
      pluginId: "p",
    })
    expect(findBalanceAdapter({ baseUrl: "https://api.myco.example/v1" })?.key).toBe("myco")
  })

  it("falls back to the built-in once the plugin adapter is unregistered", () => {
    registerBalanceAdapter("p:ds", fakeAdapter("p:ds", "deepseek"), { pluginId: "p" })
    __resetBalanceAdaptersForTesting()
    expect(findBalanceAdapter({ providerKey: "deepseek" })?.key).toBe("deepseek")
  })
})
