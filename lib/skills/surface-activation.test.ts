import {
  activeSurfaces,
  selectSurfaceSkills,
  renderSurfaceSkillsSection,
} from "./surface-activation"
import { BUILT_IN_SKILL_CATALOG } from "./built-in-catalog"

describe("activeSurfaces", () => {
  it("maps signals to surface ids", () => {
    expect(activeSurfaces({})).toEqual([])
    expect(activeSurfaces({ imBound: true })).toEqual(["im-connector"])
    expect(activeSurfaces({ computerUse: true, goalLoop: true })).toEqual([
      "computer-use",
      "goal-loop",
    ])
  })

  it("ignores falsey signals", () => {
    expect(activeSurfaces({ imBound: false, agentTeam: true })).toEqual(["agent-team"])
  })
})

describe("selectSurfaceSkills", () => {
  it("returns nothing when no surface is active", () => {
    expect(selectSurfaceSkills({})).toEqual([])
  })

  it("selects the IM skill for an IM-bound turn", () => {
    const picked = selectSurfaceSkills({ imBound: true })
    expect(picked.map((e) => e.id)).toContain("im-auto-reply")
    // does not pull in unrelated surfaces' skills
    expect(picked.map((e) => e.id)).not.toContain("computer-use-safety")
  })

  it("selects the computer-use skill for an automation turn", () => {
    expect(selectSurfaceSkills({ computerUse: true }).map((e) => e.id)).toEqual([
      "computer-use-safety",
    ])
  })

  it("selects the goal/loop skill for a standing goal", () => {
    expect(selectSurfaceSkills({ goalLoop: true }).map((e) => e.id)).toEqual([
      "goal-loop-execution",
    ])
  })

  it("unions multiple active surfaces in catalog order, de-duplicated", () => {
    const picked = selectSurfaceSkills({ imBound: true, agentTeam: true, digitalTwin: true })
    const ids = picked.map((e) => e.id)
    expect(ids).toEqual(["agent-team-delegation", "digital-twin-query", "im-auto-reply"])
    // catalog order (sorted by id) is preserved
    const order = BUILT_IN_SKILL_CATALOG.map((e) => e.id)
    expect(ids).toEqual([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
  })

  it("renders selected skills as a markdown section, empty for none", () => {
    expect(renderSurfaceSkillsSection([])).toBe("")
    const picked = selectSurfaceSkills({ imBound: true })
    const section = renderSurfaceSkillsSection(picked)
    expect(section).toContain(`## ${picked[0].name}`)
    expect(section).toContain(picked[0].content.trim())
  })

  it("never selects an opt-in (surface-less) skill like web-research / ocr", () => {
    const everySurface = selectSurfaceSkills({
      imBound: true,
      computerUse: true,
      workflowEditor: true,
      agentTeam: true,
      digitalTwin: true,
      goalLoop: true,
    })
    const ids = everySurface.map((e) => e.id)
    expect(ids).not.toContain("web-research")
    expect(ids).not.toContain("ocr-extraction")
  })
})
