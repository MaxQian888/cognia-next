import { makeComponents, makeSkill, makeTask } from "./test-fixtures"
import { validateHarnessCandidate } from "./validate"
import { HARNESS_COMPONENT_NAMES } from "@/types/harness/snapshot"

// The fixtures stand in for a real agent's harness in every suite here; if they
// stopped being a valid harness, every "rejects X" test would pass for the
// wrong reason.
describe("harness test fixtures", () => {
  it("build a harness that passes validation against itself", () => {
    const components = makeComponents()
    const report = validateHarnessCandidate(components, components, {
      editable: HARNESS_COMPONENT_NAMES,
      knownTools: ["Read", "Bash"],
    })
    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
  })

  it("let overrides replace fields", () => {
    expect(makeSkill({ key: "other" }).key).toBe("other")
    expect(makeComponents({ skills: [] }).skills).toEqual([])
    expect(makeTask({ domain: "coding" }).domain).toBe("coding")
  })
})
