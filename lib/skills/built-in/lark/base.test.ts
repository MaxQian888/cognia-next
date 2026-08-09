import { getSharedBuiltInSkillRegistry } from "../registry"
import "./base"

it("registers the certified Lark Base skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.base")
  expect(skills).toHaveLength(8)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})
