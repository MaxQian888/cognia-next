import { getSharedBuiltInSkillRegistry } from "../registry"
import "./task"

it("registers the certified Lark Task skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.task")
  expect(skills).toHaveLength(7)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})
