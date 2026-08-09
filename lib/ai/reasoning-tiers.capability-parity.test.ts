/**
 * Parity guard between the two halves of the reasoning-effort question.
 *
 *   - `lib/ai/reasoning-capability.ts:modelSupportsEffort` answers "will this
 *     model accept an effort at all" (it reads the models.dev snapshot, so it
 *     lives in the app tree).
 *   - `@cognia/provider-core/providers/reasoning-tiers` answers "which tiers
 *     does this surface offer" (it must build standalone, so it cannot import
 *     the module above and re-states the Anthropic family regexes).
 *
 * That duplication is deliberate and load-bearing — this test is what keeps it
 * honest. If the two ever disagree, the composer would either offer a ladder on
 * a model the SDK 400s on, or hide it on one that works.
 *
 * Follows the repo's existing `*.parity.test.ts` convention
 * (`lib/claude/usage.compaction-parity.test.ts`,
 * `lib/claude/permissions/ruleset.sidecar-parity.test.ts`).
 */
import { modelSupportsEffort } from "./reasoning-capability"
import { reasoningTiersFor } from "@cognia/provider-core/providers/reasoning-tiers"

/** Anthropic ids spanning both sides of the effort-GA line. */
const ANTHROPIC_MODELS = [
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-6-fast",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-4-9",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-mythos-5",
  // …and the ones that reject the parameter.
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-3-5-sonnet",
]

describe("Anthropic effort-family parity", () => {
  it.each(ANTHROPIC_MODELS)("agrees on whether %s accepts a thinking level", (model) => {
    const capable = modelSupportsEffort("anthropic", model)
    const offersTiers = reasoningTiersFor({ providerId: "anthropic", modelId: model }).length > 0
    expect(offersTiers).toBe(capable)
  })

  it("treats a missing provider as the native Anthropic path on both sides", () => {
    // `modelSupportsEffort` documents undefined-provider ⇒ anthropic; the tier
    // table's protocol default has to match or the two diverge on the app's
    // most common call shape.
    expect(modelSupportsEffort(undefined, "claude-opus-4-8")).toBe(true)
    expect(reasoningTiersFor({ providerId: undefined, modelId: "claude-opus-4-8" }).length).toBe(5)

    expect(modelSupportsEffort(undefined, "claude-haiku-4-5")).toBe(false)
    expect(reasoningTiersFor({ providerId: undefined, modelId: "claude-haiku-4-5" })).toEqual([])
  })

  it("agrees that no model at all means no tiers", () => {
    expect(modelSupportsEffort("anthropic", undefined)).toBe(false)
    expect(reasoningTiersFor({ providerId: "anthropic", modelId: undefined })).toEqual([])
  })
})

describe("non-Anthropic parity", () => {
  it("offers a ladder exactly when the capability gate says the model reasons", () => {
    // Off the native path `modelSupportsEffort` is the models.dev-backed
    // authority; the tier table takes that verdict as its `reasoning` input, so
    // feeding it back must round-trip.
    for (const [provider, model] of [
      ["openai", "gpt-5"],
      ["openai", "o3"],
      ["deepseek", "deepseek-reasoner"],
      ["openai", "gpt-4o"],
      ["groq", "llama-3.3-70b"],
    ] as const) {
      const capable = modelSupportsEffort(provider, model)
      const tiers = reasoningTiersFor({ providerId: provider, modelId: model, reasoning: capable })
      expect(tiers.length > 0).toBe(capable)
    }
  })
})
