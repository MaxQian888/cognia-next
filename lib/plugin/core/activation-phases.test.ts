import {
  PLUGIN_ACTIVATION_PHASES,
  PLUGIN_ACTIVATION_TOTAL,
  processedForPhase,
  type PluginActivationPhase,
} from "./activation-phases"

describe("phase tuple", () => {
  it("has exactly seven phases in transactional order", () => {
    expect([...PLUGIN_ACTIVATION_PHASES]).toEqual([
      "preflight",
      "dependencies",
      "schema",
      "runtime",
      "contributions",
      "hooks",
      "commit",
    ])
    expect(PLUGIN_ACTIVATION_TOTAL).toBe(7)
  })

  it("keeps the tuple and the total in sync", () => {
    expect(PLUGIN_ACTIVATION_TOTAL).toBe(PLUGIN_ACTIVATION_PHASES.length)
  })

  it("has no duplicates", () => {
    expect(new Set(PLUGIN_ACTIVATION_PHASES).size).toBe(PLUGIN_ACTIVATION_PHASES.length)
  })
})

describe("processedForPhase", () => {
  it("maps each phase to the number of phases completed on entry", () => {
    expect(processedForPhase("preflight")).toBe(0)
    expect(processedForPhase("dependencies")).toBe(1)
    expect(processedForPhase("schema")).toBe(2)
    expect(processedForPhase("runtime")).toBe(3)
    expect(processedForPhase("contributions")).toBe(4)
    expect(processedForPhase("hooks")).toBe(5)
    expect(processedForPhase("commit")).toBe(6)
  })

  it("is strictly increasing across the tuple — monotonicity is structural", () => {
    // Because `processed` is derived from the phase name alone, a later phase
    // can only ever produce a larger number. No caller can make the bar go
    // backwards by advancing.
    const counts = PLUGIN_ACTIVATION_PHASES.map(processedForPhase)
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1])
    }
  })

  it("never exceeds the total", () => {
    for (const phase of PLUGIN_ACTIVATION_PHASES) {
      expect(processedForPhase(phase)).toBeLessThan(PLUGIN_ACTIVATION_TOTAL)
    }
  })

  it("is independent of whether the phase had work to do", () => {
    // The property that makes "skipped optional work still advances" hold: the
    // function takes only a name, so a plugin with no dexie block and no
    // dependencies produces exactly the same counts as one with both.
    expect(processedForPhase("schema")).toBe(2)
    expect(processedForPhase("dependencies")).toBe(1)
  })

  it("returns 0 for an unrecognised phase rather than -1", () => {
    // Defensive: a stale persisted value must not produce a negative bar.
    expect(processedForPhase("nonsense" as PluginActivationPhase)).toBe(0)
  })
})
