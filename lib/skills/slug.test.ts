import {
  allocateUniqueSkillSlug,
  deriveMigratedSkillSlug,
  deriveSkillSlug,
  isValidSkillSlug,
} from "./slug"

describe("skill slug", () => {
  it("prefers a valid native directory basename", () => {
    expect(
      deriveSkillSlug({
        id: "skill_123456",
        name: "Display Name",
        nativeDirectory: "/x/native-name",
      })
    ).toBe("native-name")
  })

  it("uses native directory before an old portable name only during migration", () => {
    const row = {
      id: "skill_123456",
      name: "Display Name",
      slug: "frontmatter-name",
      nativeDirectory: "/x/native-name",
    }
    expect(deriveMigratedSkillSlug(row)).toBe("native-name")
    expect(deriveSkillSlug(row)).toBe("frontmatter-name")
  })

  it("normalizes ASCII display names and falls back for non-ASCII names", () => {
    expect(deriveSkillSlug({ id: "skill_abcdef", name: "My  Useful_SKILL" })).toBe(
      "my-useful-skill"
    )
    expect(deriveSkillSlug({ id: "skill_abcdef", name: "中文技能" })).toBe("skill-abcdef")
  })

  it("allocates stable collision suffixes within 64 characters", () => {
    const base = "a".repeat(64)
    const used = new Set([base, `${"a".repeat(62)}-2`])
    const allocated = allocateUniqueSkillSlug(base, used)
    expect(allocated).toBe(`${"a".repeat(62)}-3`)
    expect(allocated).toHaveLength(64)
    expect(isValidSkillSlug(allocated)).toBe(true)
  })

  it("rejects consecutive and edge hyphens", () => {
    expect(isValidSkillSlug("valid-skill")).toBe(true)
    expect(isValidSkillSlug("bad--skill")).toBe(false)
    expect(isValidSkillSlug("-bad")).toBe(false)
  })
})
