import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  UNKNOWN_MODEL_KEY,
  modelProviders,
  usageModelLabel,
  usageModelLabels,
} from "./model-labels"

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s1",
    at: 0,
    model: "ark-deepseek-v4.1-flash",
    providerId: "deepseek",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...overrides,
  }
}

const orgNames = { deepseek: { "ark-deepseek-v4.1-flash": "DeepSeek V4.1 Flash" } }

describe("modelProviders", () => {
  it("names the provider that moved most of a model's tokens", () => {
    const providers = modelProviders([
      row({ providerId: "openrouter", inputTokens: 10, outputTokens: 0 }),
      row({ providerId: "deepseek", inputTokens: 500 }),
      row({ model: " ", providerId: "anthropic" }),
      row({ model: "gpt-x", providerId: undefined }),
    ])
    expect(providers.get("ark-deepseek-v4.1-flash")).toBe("deepseek")
    expect(providers.get(UNKNOWN_MODEL_KEY)).toBe("anthropic")
    expect(providers.has("gpt-x")).toBe(false)
  })

  it("breaks a tie by provider id", () => {
    const providers = modelProviders([row({ providerId: "zeta" }), row({ providerId: "alpha" })])
    expect(providers.get("ark-deepseek-v4.1-flash")).toBe("alpha")
  })
})

describe("usageModelLabel", () => {
  it("takes the org deployment's name first", () => {
    expect(usageModelLabel("ark-deepseek-v4.1-flash", "deepseek", { orgNames })).toBe(
      "DeepSeek V4.1 Flash"
    )
  })

  it("falls back to the app catalog's name, then the id", () => {
    expect(usageModelLabel("claude-haiku-4-5-20251001", "anthropic")).not.toBe(
      "claude-haiku-4-5-20251001"
    )
    expect(usageModelLabel("ark-deepseek-v4.1-flash", "openrouter", { orgNames })).not.toBe(
      "DeepSeek V4.1 Flash"
    )
    expect(usageModelLabel("totally-unknown-model", "nobody")).toBe("totally-unknown-model")
  })

  it("reads a custom provider's own model name", () => {
    expect(
      usageModelLabel("m1", "my-proxy", {
        customProviders: [
          { id: "my-proxy", customModelMetadata: { m1: { name: "Proxy One" } } } as never,
        ],
      })
    ).toBe("Proxy One")
  })

  it("leaves the unknown bucket to the caller", () => {
    expect(usageModelLabel(UNKNOWN_MODEL_KEY, "deepseek", { orgNames })).toBeNull()
  })
})

describe("usageModelLabels", () => {
  it("labels each model key in the rows once, under its dominant provider", () => {
    expect(
      usageModelLabels(
        [row(), row({ inputTokens: 5 }), row({ model: undefined }), row({ model: "nameless" })],
        { orgNames }
      )
    ).toEqual({
      "ark-deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
      [UNKNOWN_MODEL_KEY]: null,
      nameless: "nameless",
    })
  })
})
