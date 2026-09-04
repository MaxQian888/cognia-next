/**
 * Registration smoke for the `issue.*` built-in family, a mirror of
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
  const DOCUMENTED = [
    "issue.cancel_run",
    "issue.comment",
    "issue.create",
    "issue.create_project",
    "issue.delete",
    "issue.delete_project",
    "issue.get",
    "issue.list",
    "issue.list_projects",
    "issue.run",
    "issue.update",
    "issue.update_project",
  ]

  it("registers exactly the documented skills", () => {
    expect(
      issueSkills()
        .map((s) => s.id)
        .sort()
    ).toEqual(DOCUMENTED)
  })

  it("is platform-neutral: the write path is local Dexie, never an adapter", () => {
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
    for (const id of ["issue.list", "issue.get", "issue.list_projects"]) {
      expect(byId[id]).toMatchObject({ mutation: "read", imAccess: "always" })
    }
    for (const id of [
      "issue.create",
      "issue.update",
      "issue.comment",
      "issue.run",
      "issue.cancel_run",
      "issue.create_project",
      "issue.update_project",
    ]) {
      expect(byId[id]).toMatchObject({ mutation: "write", imAccess: "always" })
    }
    // Both deletes cascade rows the user cannot get back, so neither is
    // offered in a channel that has not named it explicitly.
    for (const id of ["issue.delete", "issue.delete_project"]) {
      expect(byId[id]).toMatchObject({ mutation: "destructive", imAccess: "opt-in" })
    }
  })

  it("gives every mutating skill a hitlSurface and every read skill none", () => {
    // The registry refuses to register a non-read skill without one, so this
    // pins the intent rather than re-testing the guard.
    for (const skill of issueSkills()) {
      if (skill.mutation === "read") expect(skill.hitlSurface).toBeUndefined()
      else expect(skill.hitlSurface).toBeDefined()
    }
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

  it("is idempotent: the barrel may be imported twice without a duplicate-id throw", async () => {
    await expect(import("./index")).resolves.toBeDefined()
    expect(issueSkills()).toHaveLength(DOCUMENTED.length)
  })

  it("reaches a desktop session's tool manifest, not just the registry", async () => {
    // Registering is not the same as being offered. This repo's recurrent
    // defect is a fully-built surface nothing ever exposes, so the census is
    // taken against the manifest the assistant actually sees.
    const { buildBuiltInSkillManifest } = await import("../manifest")
    const offered = buildBuiltInSkillManifest({ platform: undefined })
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("issue_"))

    expect(offered.sort()).toEqual(DOCUMENTED.map((id) => id.replace(/\./g, "_")).sort())
  })

  it("documents in the barrel every skill it registers", async () => {
    // The header table is the family's contract. A tool added without a row
    // there is a tool nobody reviewing this directory knows exists.
    const { readFileSync } = await import("node:fs")
    const barrel = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    for (const id of DOCUMENTED) {
      expect(barrel).toContain(`| ${id.padEnd(25)} |`)
    }
  })
})
