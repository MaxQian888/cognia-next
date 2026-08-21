/**
 * Registration smoke for the `issue.*` built-in family — mirror of
 * `im/families.test.ts`, scoped to `issue.*` rows because the shared registry
 * may also hold other families depending on import order.
 */
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./index"

function issueSkills() {
  return getSharedBuiltInSkillRegistry()
    .list()
    .filter((s) => s.family === "issue")
}

describe("issue.* skill family — registration smoke", () => {
  it("registers exactly the two documented skills", () => {
    expect(
      issueSkills()
        .map((s) => s.id)
        .sort()
    ).toEqual(["issue.create", "issue.list_projects"])
  })

  it("is platform-neutral — the write path is local Dexie, never an adapter", () => {
    for (const skill of issueSkills()) {
      expect(skill.platforms).toBe("any")
    }
  })

  it("requires no connector capability", () => {
    for (const skill of issueSkills()) {
      expect(skill.requires ?? []).toEqual([])
    }
  })

  it("mutation / imAccess tiers match the family's design table", () => {
    const byId = Object.fromEntries(issueSkills().map((s) => [s.id, s]))
    expect(byId["issue.create"]).toMatchObject({ mutation: "write", imAccess: "always" })
    expect(byId["issue.list_projects"]).toMatchObject({ mutation: "read", imAccess: "always" })
  })

  it("gives the write skill a hitlSurface and the read skill none", () => {
    const byId = Object.fromEntries(issueSkills().map((s) => [s.id, s]))
    // The registry refuses to register a non-read skill without one, so this
    // pins the intent rather than re-testing the guard.
    expect(byId["issue.create"].hitlSurface).toBeDefined()
    expect(byId["issue.list_projects"].hitlSurface).toBeUndefined()
  })

  it("mcpToolName follows the family_suffix convention", () => {
    for (const skill of issueSkills()) {
      expect(skill.mcpToolName).toBe(skill.id.replace(/\./g, "_"))
    }
  })

  it("ships both locales for every label and description", () => {
    for (const skill of issueSkills()) {
      expect(skill.label.en).toBeTruthy()
      expect(skill.label["zh-CN"]).toBeTruthy()
      expect(skill.description.en).toBeTruthy()
      expect(skill.description["zh-CN"]).toBeTruthy()
    }
  })

  it("is idempotent — the barrel may be imported twice without a duplicate-id throw", async () => {
    await expect(import("./index")).resolves.toBeDefined()
    expect(issueSkills()).toHaveLength(2)
  })
})
