import { BALANCE_ADAPTERS, findBalanceAdapter } from "./registry"

describe("balance registry", () => {
  it("lists only documented adapters", () => {
    expect(BALANCE_ADAPTERS.map((a) => a.key).sort()).toEqual([
      "deepseek",
      "moonshot",
      "openrouter",
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
