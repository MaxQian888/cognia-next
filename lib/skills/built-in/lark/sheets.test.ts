import { getSharedBuiltInSkillRegistry } from "../registry"
import "./sheets"

it("registers the certified Lark Sheets skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.sheets")
  expect(skills).toHaveLength(7)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})
