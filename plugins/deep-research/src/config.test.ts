import type { PluginContext } from "@cognia/plugin-sdk"

import { readEngineConfig } from "./config"

function context(config: Record<string, unknown>): PluginContext {
  return { configuration: { getAll: () => config } } as unknown as PluginContext
}

describe("readEngineConfig", () => {
  it("reads every numeric budget plus the locale", () => {
    expect(
      readEngineConfig(
        context({
          tokenBudget: 42,
          maxSteps: 7,
          maxBadAttempts: 3,
          readTopK: 2,
          searchResultsPerQuery: 9,
          locale: " zh-CN ",
        })
      )
    ).toEqual({
      tokenBudget: 42,
      maxSteps: 7,
      maxBadAttempts: 3,
      readTopK: 2,
      searchResultsPerQuery: 9,
      locale: "zh-CN",
    })
  })

  it("returns nothing when configuration is empty, leaving engine defaults in force", () => {
    expect(readEngineConfig(context({}))).toEqual({})
  })

  it("drops non-positive and non-finite budgets", () => {
    // A zero step ceiling ends the run before it starts, and NaN poisons every
    // comparison downstream — both are worse than the schema default.
    expect(
      readEngineConfig(
        context({ maxSteps: 0, tokenBudget: -1, readTopK: Number.NaN, searchResultsPerQuery: "6" })
      )
    ).toEqual({})
  })

  it("ignores a blank locale", () => {
    expect(readEngineConfig(context({ locale: "   " }))).toEqual({})
  })

  it("does not read search-provider credentials — those live in app settings", () => {
    // The plugin no longer owns a provider or a key; search runs through the
    // host's promoted web tools with the user's configured provider.
    const out = readEngineConfig(
      context({ searchProvider: "exa", exaApiKey: "secret", tavilyApiKey: "secret" })
    )
    expect(out).toEqual({})
    expect(JSON.stringify(out)).not.toContain("secret")
  })
})
