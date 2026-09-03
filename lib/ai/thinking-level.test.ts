import {
  EFFORT_SLIDER_LEVELS,
  availableThinkingLevels,
  clampThinkingLevel,
  SDK_EFFORT_LEVELS,
  THINKING_LEVELS,
  isUltracodeLevel,
  resolveThinkingLevel,
  thinkingLevelAtIndex,
  thinkingLevelIndex,
  thinkingLevelPatch,
  thinkingLevelToEffort,
  type EffortTier,
  type ThinkingLevel,
  externalAgentThinkingLevels,
} from "./thinking-level"

describe("the tier ladder", () => {
  it("lists every tier once, ascending, with off leading", () => {
    expect(THINKING_LEVELS).toEqual(["off", "low", "medium", "high", "xhigh", "max", "ultracode"])
    expect(new Set(THINKING_LEVELS).size).toBe(THINKING_LEVELS.length)
  })

  it("drops only 'off' from the slider tiers", () => {
    expect(EFFORT_SLIDER_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
  })

  it("drops both Cognia-specific tiers from the SDK effort tiers", () => {
    // Presets and `AppSettings.defaultEffort` store a raw `SendOptions.effort`,
    // which has no slot for "off" or the composite "ultracode".
    expect(SDK_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"])
  })
})

describe("thinkingLevelToEffort", () => {
  it("forwards nothing for 'off' or an unset level", () => {
    expect(thinkingLevelToEffort("off")).toBeUndefined()
    expect(thinkingLevelToEffort(undefined)).toBeUndefined()
  })

  it("maps ultracode down to xhigh — its extra behaviour is the tool coupling", () => {
    expect(thinkingLevelToEffort("ultracode")).toBe("xhigh")
  })

  it("passes the SDK tiers through unchanged", () => {
    for (const level of SDK_EFFORT_LEVELS) {
      expect(thinkingLevelToEffort(level)).toBe(level)
    }
  })
})

describe("isUltracodeLevel", () => {
  it("is true only for the composite top tier", () => {
    expect(isUltracodeLevel("ultracode")).toBe(true)
    for (const level of ["off", ...SDK_EFFORT_LEVELS] as ThinkingLevel[]) {
      expect(isUltracodeLevel(level)).toBe(false)
    }
    expect(isUltracodeLevel(undefined)).toBe(false)
  })
})

describe("resolveThinkingLevel", () => {
  it("prefers the explicit tier over the effort it maps to", () => {
    // The whole point of the field: xhigh-the-tier and ultracode-the-tier both
    // persist `effort: "xhigh"`, so only `thinkingLevel` can tell them apart.
    expect(resolveThinkingLevel({ effort: "xhigh", thinkingLevel: "ultracode" })).toBe("ultracode")
    expect(resolveThinkingLevel({ effort: "xhigh", thinkingLevel: "xhigh" })).toBe("xhigh")
  })

  it("derives the tier from effort for legacy rows that predate the field", () => {
    expect(resolveThinkingLevel({ effort: "high" })).toBe("high")
  })

  it("never infers ultracode from a bare xhigh — that would turn tools on silently", () => {
    expect(resolveThinkingLevel({ effort: "xhigh" })).toBe("xhigh")
  })

  it("falls back to 'off' for an untouched, null, or undefined session", () => {
    expect(resolveThinkingLevel({})).toBe("off")
    expect(resolveThinkingLevel(null)).toBe("off")
    expect(resolveThinkingLevel(undefined)).toBe("off")
  })

  it("honours an explicitly persisted 'off'", () => {
    expect(resolveThinkingLevel({ thinkingLevel: "off" })).toBe("off")
  })
})

describe("thinkingLevelPatch", () => {
  it("writes both fields so effort and tier can never disagree", () => {
    expect(thinkingLevelPatch("high")).toEqual({ effort: "high", thinkingLevel: "high" })
  })

  it("clears effort but records the tier when the user opts out", () => {
    // `effort: undefined` is what makes `updateSession` drop a previously
    // persisted level; `thinkingLevel: "off"` records that it was deliberate.
    expect(thinkingLevelPatch("off")).toEqual({ effort: undefined, thinkingLevel: "off" })
  })

  it("stores xhigh effort under the ultracode tier", () => {
    expect(thinkingLevelPatch("ultracode")).toEqual({
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
  })

  it("round-trips every tier through resolveThinkingLevel", () => {
    for (const level of THINKING_LEVELS) {
      expect(resolveThinkingLevel(thinkingLevelPatch(level))).toBe(level)
    }
  })
})

describe("availableThinkingLevels", () => {
  it("gives Anthropic's effort-GA models the full ladder plus ultracode", () => {
    expect(
      availableThinkingLevels({ providerId: "anthropic", modelId: "claude-opus-4-8" })
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
  })

  it("drops max on OpenAI-native, which rejects it, but keeps ultracode", () => {
    // `normalizeOpenAiEffort` folds max→xhigh, so offering max would be a
    // control with no distinct effect. xhigh survives, so ultracode is honest.
    expect(availableThinkingLevels({ providerId: "openai", modelId: "gpt-5" })).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ])
  })

  it("never offers minimal — the app has no way to persist or forward it", () => {
    // OpenAI's surface has a `minimal` tier, but `SendOptions["effort"]` does not.
    expect(availableThinkingLevels({ providerId: "openai", modelId: "gpt-5" })).not.toContain(
      "minimal"
    )
  })

  it("withholds ultracode where xhigh folds away", () => {
    // A generic gateway maps xhigh AND max down to `high`, so an "ultracode"
    // label would promise a depth the request never carries.
    expect(
      availableThinkingLevels({ providerId: "deepseek", modelId: "deepseek-reasoner" })
    ).toEqual(["low", "medium", "high"])
  })

  it("offers nothing on a model that cannot take a level at all", () => {
    expect(
      availableThinkingLevels({ providerId: "anthropic", modelId: "claude-haiku-4-5" })
    ).toEqual([])
    expect(
      availableThinkingLevels({ providerId: "openai", modelId: "gpt-4o", reasoning: false })
    ).toEqual([])
  })
})

describe("clampThinkingLevel", () => {
  const GATEWAY: EffortTier[] = ["low", "medium", "high"]
  const FULL: EffortTier[] = ["low", "medium", "high", "xhigh", "max", "ultracode"]

  it("leaves a tier the model offers alone", () => {
    expect(clampThinkingLevel("high", FULL)).toBe("high")
    expect(clampThinkingLevel("ultracode", FULL)).toBe("ultracode")
  })

  it("folds downward, matching the direction every wire normalizer folds", () => {
    // A session set to `max` on Opus, then switched to a gateway, really sends
    // `high` — showing `max` would misreport the turn.
    expect(clampThinkingLevel("max", GATEWAY)).toBe("high")
    expect(clampThinkingLevel("xhigh", GATEWAY)).toBe("high")
    expect(clampThinkingLevel("ultracode", GATEWAY)).toBe("high")
  })

  it("passes 'off' through — it is offered on every surface", () => {
    expect(clampThinkingLevel("off", GATEWAY)).toBe("off")
  })

  it("reports 'off' when the model offers nothing", () => {
    expect(clampThinkingLevel("high", [])).toBe("off")
  })

  it("rises to the shallowest tier when the request sits below the whole list", () => {
    expect(clampThinkingLevel("low", ["medium", "high"] as EffortTier[])).toBe("medium")
  })
})

describe("thinkingLevelIndex / thinkingLevelAtIndex", () => {
  it("indexes the slider tiers in order", () => {
    expect(thinkingLevelIndex("low")).toBe(0)
    expect(thinkingLevelIndex("ultracode")).toBe(EFFORT_SLIDER_LEVELS.length - 1)
  })

  it("reports -1 for 'off' and an unset level (no marker on the track)", () => {
    expect(thinkingLevelIndex("off")).toBe(-1)
    expect(thinkingLevelIndex(undefined)).toBe(-1)
  })

  it("clamps out-of-range indices instead of throwing", () => {
    // Arrow keys at either end of the track land here every time.
    expect(thinkingLevelAtIndex(-5)).toBe("low")
    expect(thinkingLevelAtIndex(999)).toBe("ultracode")
  })

  it("collapses a non-finite index to a real tier", () => {
    // NaN passes straight through Math.min/Math.max and would index to
    // `undefined` — a value the return type says cannot happen, which callers
    // would then persist onto the session.
    expect(thinkingLevelAtIndex(Number.NaN)).toBe("low")
    expect(thinkingLevelAtIndex(Number.POSITIVE_INFINITY)).toBe("low")
  })

  it("round-trips every slider tier", () => {
    for (const level of EFFORT_SLIDER_LEVELS) {
      expect(thinkingLevelAtIndex(thinkingLevelIndex(level))).toBe(level)
    }
  })
})

describe("externalAgentThinkingLevels", () => {
  it("offers the agent's own ladder when it published one", () => {
    // The whole point of picking a Pi model that honours `max`. The generic
    // fallback stops at `high`, so every tier above it was unreachable.
    expect(externalAgentThinkingLevels(["off", "low", "medium", "high", "xhigh", "max"])).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  it("drops levels the app cannot persist or express", () => {
    // `off` is the app's separate "leave the model alone" choice and is always
    // reachable; `minimal` has no representation in SendOptions["effort"].
    const levels = externalAgentThinkingLevels(["off", "minimal", "low"])
    expect(levels).toEqual(["low"])
  })

  it("never offers ultracode, even for an agent that publishes xhigh", () => {
    // The tier IS `xhigh` plus Cognia's dynamic-workflow tool suite, which the
    // built-in send path injects. An external agent brings its own tools, so
    // the name would promise something this turn cannot carry.
    expect(externalAgentThinkingLevels(["xhigh", "max"])).not.toContain("ultracode")
  })

  it("re-orders a deepest-first agent into the app's ascending order", () => {
    // The slider indexes into this list. Trusting publication order would
    // invert the control for an agent that lists its levels the other way.
    expect(externalAgentThinkingLevels(["max", "low", "high"])).toEqual(["low", "high", "max"])
  })

  it("falls back to the generic ladder when the agent has not answered", () => {
    const fallback = externalAgentThinkingLevels()
    expect(externalAgentThinkingLevels([])).toEqual(fallback)
    expect(fallback.length).toBeGreaterThan(0)
    // Nothing above `high` may be invented for an agent that never said.
    expect(fallback).not.toContain("max")
  })

  it("ignores a vocabulary the app shares no level with", () => {
    // An agent speaking entirely its own words gets the generic ladder rather
    // than an empty control that offers nothing at all.
    expect(externalAgentThinkingLevels(["think-a-bit", "think-a-lot"])).toEqual(
      externalAgentThinkingLevels()
    )
  })
})
