import { DEFAULT_HARNESS_BUDGET } from "./budget"
import {
  DEFAULT_HARNESS_EVOLUTION_SETTINGS,
  harnessEvolutionSettingsOf,
  isStartAllowed,
  resolveHarnessEvolutionSettings,
} from "./settings"

describe("resolveHarnessEvolutionSettings", () => {
  it("is off with defaults when nothing is stored", () => {
    expect(resolveHarnessEvolutionSettings(undefined)).toEqual(DEFAULT_HARNESS_EVOLUTION_SETTINGS)
    expect(harnessEvolutionSettingsOf({})).toMatchObject({ enabled: false, startMode: "manual" })
    expect(harnessEvolutionSettingsOf(null).budget).toEqual(DEFAULT_HARNESS_BUDGET)
  })

  it("clamps numbers, drops unknown enum values and empty model choices", () => {
    const s = resolveHarnessEvolutionSettings({
      enabled: true,
      startMode: "always" as never,
      defaultMode: "sequential",
      defaultK: 9,
      budget: { maxIterations: 2, maxCandidates: 4 },
      editorChannel: "magic" as never,
      models: { editor: { model: " opus " }, selector: { model: " " } },
      probeAllowedMcpServerIds: ["b", " a ", "", "b"],
      backgroundIntervalHours: 0,
      failureOfferCooldownHours: -3,
      experienceCapPerAgent: 5,
    })
    expect(s.enabled).toBe(true)
    expect(s.startMode).toBe("manual")
    expect(s.defaultMode).toBe("sequential")
    expect(s.defaultK).toBe(2)
    expect(s.editorChannel).toBe("auto")
    expect(s.models).toEqual({ editor: { model: "opus" } })
    expect(s.probeAllowedMcpServerIds).toEqual(["a", "b"])
    expect(s.backgroundIntervalHours).toBe(1)
    expect(s.failureOfferCooldownHours).toBe(0)
    expect(s.experienceCapPerAgent).toBe(20)
  })

  it("treats only an explicit true as on and only an explicit false as off", () => {
    expect(resolveHarnessEvolutionSettings({ enabled: "yes" as never }).enabled).toBe(false)
    expect(resolveHarnessEvolutionSettings({ useExperiences: false }).useExperiences).toBe(false)
    expect(resolveHarnessEvolutionSettings({ autoAdoptLowRisk: 1 as never }).autoAdoptLowRisk).toBe(
      false
    )
  })
})

describe("isStartAllowed", () => {
  it("is false whenever the feature is off", () => {
    expect(isStartAllowed({ enabled: false, startMode: "background" }, "manual")).toBe(false)
  })

  it("orders the start modes", () => {
    const failure = { enabled: true, startMode: "failure-triggered" as const }
    expect(isStartAllowed(failure, "manual")).toBe(true)
    expect(isStartAllowed(failure, "failure-triggered")).toBe(true)
    expect(isStartAllowed(failure, "background")).toBe(false)
    expect(isStartAllowed({ enabled: true, startMode: "disabled" }, "manual")).toBe(false)
    expect(isStartAllowed({ enabled: true, startMode: "background" }, "background")).toBe(true)
  })
})
