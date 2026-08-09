import { isValidSkill, validateSkill } from "./validate"
import type { Skill } from "@cognia/agent-config-types"

describe("validateSkill", () => {
  it("flags an empty name", () => {
    const errs = validateSkill({ name: "", content: "body" })
    expect(errs.some((e) => e.code === "missing-name")).toBe(true)
  })

  it("flags a name that's too long", () => {
    const errs = validateSkill({ name: "a".repeat(65), content: "body" })
    expect(errs.some((e) => e.code === "name-too-long")).toBe(true)
  })

  it("flags a name with disallowed characters", () => {
    const errs = validateSkill({ name: "Bad@Name", content: "body" })
    expect(errs.some((e) => e.code === "name-format")).toBe(true)
  })

  it("accepts a name with hyphens, underscores, spaces, digits", () => {
    const errs = validateSkill({
      name: "Skill 42_Name-OK",
      slug: "skill-42-name-ok",
      description: "Useful skill",
      content: "body",
    })
    expect(errs).toHaveLength(0)
  })

  it("flags an empty content body", () => {
    const errs = validateSkill({ name: "Good", content: "   " })
    expect(errs.some((e) => e.code === "missing-content")).toBe(true)
  })

  it("flags an over-long description", () => {
    const errs = validateSkill({
      name: "Good",
      slug: "good",
      description: "x".repeat(1025),
      content: "body",
    })
    expect(errs.some((e) => e.code === "description-too-long")).toBe(true)
  })

  it("flags resource path traversal", () => {
    const errs = validateSkill({
      name: "Good",
      slug: "good",
      description: "Useful skill",
      content: "body",
      resources: [{ id: "r1", path: "scripts/../../etc/passwd" }],
    })
    expect(errs.some((e) => e.code === "resource-path-traversal")).toBe(true)
  })

  it("flags duplicate resource paths case-insensitively", () => {
    const errs = validateSkill({
      name: "Good",
      slug: "good",
      description: "Useful skill",
      content: "body",
      resources: [
        { id: "r1", path: "scripts/foo.sh" },
        { id: "r2", path: "Scripts/Foo.sh" },
      ],
    })
    expect(errs.some((e) => e.code === "duplicate-resource-path")).toBe(true)
  })

  it("returns no errors for a clean draft", () => {
    expect(
      validateSkill({
        name: "Good",
        slug: "good",
        description: "x",
        content: "body",
        resources: [{ id: "r1", path: "scripts/setup.sh" }],
      })
    ).toEqual([])
  })

  it("isValidSkill returns true for a valid skill row", () => {
    const skill: Skill = {
      id: "skill_1",
      slug: "good",
      name: "Good",
      description: "Useful skill",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
    }
    expect(isValidSkill(skill)).toBe(true)
  })

  it("isValidSkill returns false for an invalid skill row", () => {
    const skill: Skill = {
      id: "skill_2",
      slug: "bad",
      name: "",
      description: "Useful skill",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
    }
    expect(isValidSkill(skill)).toBe(false)
  })

  it("classifies standard portability and runtime issues", () => {
    const errs = validateSkill({
      name: "中文显示名",
      slug: "bad--slug",
      description: "",
      compatibility: "x".repeat(501),
      metadata: { ok: "yes", bad: 1 },
      content: "",
    })
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "slug-format", severity: "portability" }),
        expect.objectContaining({ code: "missing-description", severity: "portability" }),
        expect.objectContaining({ code: "compatibility-too-long", severity: "portability" }),
        expect.objectContaining({ code: "metadata-format", severity: "portability" }),
        expect.objectContaining({ code: "missing-content", severity: "runtime" }),
      ])
    )
  })
})
