import { modelFamilyOf } from "./model-family"

describe("modelFamilyOf", () => {
  it.each([
    ["claude-sonnet-4-5-20250929", "claude-sonnet"],
    ["claude-3-5-sonnet-latest", "claude-sonnet"],
    ["claude-opus-4-1", "claude-opus"],
    ["claude-haiku-4-5", "claude-haiku"],
    ["gemini-2.5-pro", "gemini-pro"],
    ["gemini-2.5-flash-preview", "gemini-flash"],
    ["gpt-4o-mini", "gpt-mini"],
    ["gpt-5.1-codex", "gpt-codex"],
    ["deepseek-v3.2", "deepseek"],
    ["kimi-k2", "kimi-k2"],
    ["o3", "o3"],
  ])("%s → %s", (id, family) => {
    expect(modelFamilyOf(id)).toBe(family)
  })

  it("strips provider paths, marketplace prefixes, tags and revisions", () => {
    expect(modelFamilyOf("openrouter/anthropic/claude-sonnet-4")).toBe("claude-sonnet")
    expect(modelFamilyOf("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet")
    expect(modelFamilyOf("llama3:8b")).toBe("llama3")
  })

  it("drops a reasoning-effort suffix so effort tiers share a family", () => {
    expect(modelFamilyOf("gpt-5-high")).toBe(modelFamilyOf("gpt-5-low"))
  })

  it("is case-insensitive", () => {
    expect(modelFamilyOf("Claude-Sonnet-4")).toBe("claude-sonnet")
  })

  it("returns null for empty or all-version ids", () => {
    expect(modelFamilyOf(undefined)).toBeNull()
    expect(modelFamilyOf(null)).toBeNull()
    expect(modelFamilyOf("  ")).toBeNull()
    expect(modelFamilyOf("4-20250101")).toBeNull()
  })
})
