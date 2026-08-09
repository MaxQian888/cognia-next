import { getSharedBuiltInSkillRegistry } from "../registry"
import "./doc"

it("registers the certified Lark Docs skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.doc")
  expect(skills).toHaveLength(6)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})
