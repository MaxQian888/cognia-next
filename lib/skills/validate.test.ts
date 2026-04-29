import { isValidSkill, validateSkill } from "./validate"
import type { Skill } from "@/lib/claude/types"

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
      description: "x".repeat(1025),
      content: "body",
    })
    expect(errs.some((e) => e.code === "description-too-long")).toBe(true)
  })

  it("flags resource path traversal", () => {
    const errs = validateSkill({
      name: "Good",
      content: "body",
      resources: [{ id: "r1", path: "scripts/../../etc/passwd" }],
    })
    expect(errs.some((e) => e.code === "resource-path-traversal")).toBe(true)
  })

  it("flags duplicate resource paths case-insensitively", () => {
    const errs = validateSkill({
      name: "Good",
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
        description: "x",
        content: "body",
        resources: [{ id: "r1", path: "scripts/setup.sh" }],
      })
    ).toEqual([])
  })

  it("isValidSkill returns true for a valid skill row", () => {
    const skill: Skill = {
      id: "skill_1",
      name: "Good",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
    }
    expect(isValidSkill(skill)).toBe(true)
  })

  it("isValidSkill returns false for an invalid skill row", () => {
    const skill: Skill = {
      id: "skill_2",
      name: "",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
    }
    expect(isValidSkill(skill)).toBe(false)
  })
})
