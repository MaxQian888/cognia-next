import { makePetProfile } from "@/lib/storybook/fixtures/pet-core"
import { projectPetSummary } from "./summary"

const NOW = Date.UTC(2026, 5, 29, 9, 0)

describe("projectPetSummary", () => {
  it("projects the public shape", () => {
    const summary = projectPetSummary(makePetProfile(), NOW)
    expect(summary).toMatchObject({
      hatched: true,
      level: 7,
      stage: "adult",
      xp: 1240,
    })
    expect(typeof summary.name).toBe("string")
    expect(summary.needs).toEqual({
      energy: expect.any(Number),
      mood: expect.any(Number),
      bond: expect.any(Number),
    })
  })

  it("never leaks the appearance seed or the raw bones and soul", () => {
    // The red line. `accountFingerprint` derives from the user's provider
    // account id, `bones` describes the generated body, and `soul` carries
    // more than the chosen name. A plugin and the agent both see only this.
    const summary = projectPetSummary(
      makePetProfile({ accountFingerprint: "acct-secret-value" }),
      NOW
    )
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain("acct-secret-value")
    expect(Object.keys(summary).sort()).toEqual([
      "coins",
      "condition",
      "hatched",
      "level",
      "mood",
      "name",
      "needs",
      "stage",
      "xp",
    ])
  })

  it("reports an unhatched egg as a nameless pet rather than failing", () => {
    const summary = projectPetSummary(makePetProfile({ soul: null, stage: "egg" }), NOW)
    expect(summary.hatched).toBe(false)
    expect(summary.name).toBeNull()
  })

  it("floors a legacy row with no coin balance to zero", () => {
    expect(projectPetSummary(makePetProfile({ coins: undefined }), NOW).coins).toBe(0)
    expect(projectPetSummary(makePetProfile({ coins: 12.7 }), NOW).coins).toBe(12)
    expect(projectPetSummary(makePetProfile({ coins: -5 }), NOW).coins).toBe(0)
  })
})
