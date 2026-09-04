import { modelSupportsEffort as sharedModelSupportsEffort } from "@/lib/ai/reasoning-capability"
import { deriveEffortSliderState, modelSupportsEffort, thinkingLevelToEffort } from "./thinking"
import { EFFORT_SLIDER_LEVELS, type ThinkingLevel } from "./schema"

describe("thinkingLevelToEffort", () => {
  it("maps each non-off level to the matching effort", () => {
    expect(thinkingLevelToEffort("low")).toBe("low")
    expect(thinkingLevelToEffort("medium")).toBe("medium")
    expect(thinkingLevelToEffort("high")).toBe("high")
    expect(thinkingLevelToEffort("xhigh")).toBe("xhigh")
    expect(thinkingLevelToEffort("max")).toBe("max")
  })

  it("maps ultracode to xhigh effort (the composite top tier)", () => {
    expect(thinkingLevelToEffort("ultracode")).toBe("xhigh")
  })

  it("returns undefined for off / unset (model default)", () => {
    expect(thinkingLevelToEffort("off")).toBeUndefined()
    expect(thinkingLevelToEffort(undefined)).toBeUndefined()
  })
})

describe("deriveEffortSliderState", () => {
  it("treats off / unset as the off checkbox, slider parked at low", () => {
    expect(deriveEffortSliderState("off")).toEqual({ off: true, index: 0 })
    expect(deriveEffortSliderState(undefined)).toEqual({ off: true, index: 0 })
  })

  it("maps each non-off level to its slider index with off unchecked", () => {
    for (const [i, level] of EFFORT_SLIDER_LEVELS.entries()) {
      expect(deriveEffortSliderState(level)).toEqual({ off: false, index: i })
    }
  })

  it("parks ultracode at the last slider index", () => {
    expect(deriveEffortSliderState("ultracode")).toEqual({
      off: false,
      index: EFFORT_SLIDER_LEVELS.length - 1,
    })
  })

  it("parks an unrecognised level at the fast end rather than at index -1", () => {
    // A `config.json` hand-edited to a tier this build no longer knows would
    // otherwise seed the overlay's marker off the end of the track.
    expect(deriveEffortSliderState("turbo" as ThinkingLevel)).toEqual({ off: false, index: 0 })
  })
})

// The per-model matrix lives with the capability itself
// (`lib/ai/reasoning-capability.test.ts`). Restating it here made this suite a
// second, weaker copy of the model table that drifted the moment the real one
// changed: it still vouched for `claude-mythos-5` after that id was removed for
// naming a model no catalog carries. What this module actually owns is the
// re-export, so that is what it pins.
describe("modelSupportsEffort re-export", () => {
  it("is the shared capability itself, not a CLI-local copy", () => {
    expect(modelSupportsEffort).toBe(sharedModelSupportsEffort)
  })

  it("reaches the shared gate for a representative allow and deny", () => {
    expect(modelSupportsEffort("anthropic", "claude-opus-5")).toBe(true)
    expect(modelSupportsEffort("anthropic", "claude-haiku-4-5")).toBe(false)
    expect(modelSupportsEffort("anthropic", undefined)).toBe(false)
  })
})
