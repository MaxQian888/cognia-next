import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"

describe("modelSupportsEffort", () => {
  it("returns false when no model is resolved", () => {
    expect(modelSupportsEffort("anthropic", undefined)).toBe(false)
    expect(modelSupportsEffort("anthropic", "")).toBe(false)
  })

  describe("Anthropic (native) path", () => {
    it("accepts effort on Opus 4.5–4.9, Sonnet 4.6, and Fable/Mythos 5", () => {
      for (const id of [
        "claude-opus-4-5",
        "claude-opus-4-6-20250101",
        "claude-opus-4-6-fast", // date-suffixed and -fast variants resolve the same
        "claude-opus-4-9",
        "claude-sonnet-4-6",
        "claude-fable-5",
        "claude-mythos-5",
      ]) {
        expect(modelSupportsEffort("anthropic", id)).toBe(true)
      }
    })

    // Regression: the family table predated the Claude 5 release and matched
    // only `opus-4-5…4-9` / `sonnet-4-6` / `fable-5`. The built-in Anthropic
    // provider ships `claude-sonnet-5` as its default model, so on a stock
    // install this gate said "no effort", `availableThinkingLevels` returned an
    // empty ladder, and the composer's thinking-level control removed itself
    // entirely — the feature read as missing rather than broken.
    it("accepts effort across the Claude 5 family", () => {
      for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
        expect(modelSupportsEffort("anthropic", id)).toBe(true)
      }
    })

    // Bedrock/Vertex/gateway spellings carry a prefix or a suffix around the
    // same family fragment. Matching on the fragment is what makes them work,
    // so pin it: a future tightening to a whole-string match would break every
    // non-direct Anthropic route at once.
    it("accepts effort on vendor-prefixed Claude 5 ids", () => {
      for (const id of [
        "us.anthropic.claude-opus-5",
        "global.anthropic.claude-sonnet-5",
        "claude-sonnet-5@default",
        "anthropic/claude-opus-5",
      ]) {
        expect(modelSupportsEffort("anthropic", id)).toBe(true)
      }
    })

    // The `-5` suffix must not leak onto 4.x ids that merely contain a "5":
    // `claude-sonnet-4-5` ends in `-5` but rejects the parameter, so an
    // over-broad `/-5/` would 400 every turn on the previous generation.
    it("does not let the Claude 5 rule swallow 4.5-generation ids", () => {
      for (const id of [
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5-20251001",
      ]) {
        expect(modelSupportsEffort("anthropic", id)).toBe(false)
      }
    })

    it("rejects effort on Haiku, Sonnet 4.5-and-earlier, and Opus 4.1/4.0", () => {
      for (const id of [
        "claude-haiku-4-5",
        "claude-3-5-haiku",
        "claude-sonnet-4-5",
        "claude-sonnet-3-7",
        "claude-opus-4-1",
        "claude-opus-4-0",
      ]) {
        expect(modelSupportsEffort("anthropic", id)).toBe(false)
      }
    })

    it("treats a falsy/unknown provider as the native Anthropic dispatcher", () => {
      expect(modelSupportsEffort(undefined, "claude-opus-4-6")).toBe(true)
      expect(modelSupportsEffort(undefined, "claude-haiku-4-5")).toBe(false)
    })
  })

  describe("Non-Anthropic (ai-sdk) path", () => {
    it("accepts effort for reasoning-model ids", () => {
      for (const [provider, id] of [
        ["openai", "o1"],
        ["openai", "o3-mini"],
        ["openai", "gpt-5.2"],
        ["openai", "deepseek-reasoner"],
        ["google", "gemini-2.5-flash-thinking"],
        ["openai", "qwen-qwq-32b-thinking"],
        ["openai", "deepseek-r1"],
        ["openai", "some-reasoning-model"],
      ] as const) {
        expect(modelSupportsEffort(provider, id)).toBe(true)
      }
    })

    it("rejects effort for plain non-reasoning models", () => {
      for (const id of ["gpt-4o-mini", "gpt-4.1", "mistral-large", "command-r-plus"]) {
        expect(modelSupportsEffort("openai", id)).toBe(false)
      }
    })

    it("does not misfire on a bare 'o' or embedded letters", () => {
      // The o-series pattern requires a word boundary so "託o5" style ids or
      // words containing "o<digit>" inside a token don't match spuriously.
      expect(modelSupportsEffort("openai", "model")).toBe(false)
      expect(modelSupportsEffort("openai", "groq-llama")).toBe(false)
    })
  })
})
