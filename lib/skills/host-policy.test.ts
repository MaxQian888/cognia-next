import { BUILT_IN_SKILL_CATALOG } from "./built-in-catalog"
import { resolveResidentSkillHostPolicies, SKILL_HOST_POLICY_OWNERS } from "./host-policy"

describe("built-in Skill host-policy bindings", () => {
  it("binds every generated policy to one host enforcement owner", () => {
    const declared = new Set(BUILT_IN_SKILL_CATALOG.flatMap((entry) => entry.hostPolicies))
    expect(new Set(Object.keys(SKILL_HOST_POLICY_OWNERS))).toEqual(declared)
    expect(resolveResidentSkillHostPolicies([...declared])).toHaveLength(declared.size)
  })

  it("fails closed on descriptor drift", () => {
    expect(() => resolveResidentSkillHostPolicies(["unknown-policy"])).toThrow(/Unknown/)
  })
})
