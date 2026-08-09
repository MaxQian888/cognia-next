import { getSharedBuiltInSkillRegistry } from "../registry"
import "./wiki"

it("registers the certified Lark Wiki skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.wiki")
  expect(skills).toHaveLength(4)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})
