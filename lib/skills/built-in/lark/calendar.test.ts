import { getSharedBuiltInSkillRegistry } from "../registry"
import "./calendar"

it("registers the certified Lark Calendar skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.calendar")
  expect(skills).toHaveLength(9)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})
