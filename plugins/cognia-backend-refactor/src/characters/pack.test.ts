import { REFACTOR_ROLE_PACK, REFACTOR_ROLES, REFACTOR_PACK_ID, roleCharacterId } from "./pack"
import { PLUGIN_ID, packSkillId } from "../ids"

describe("REFACTOR_ROLE_PACK", () => {
  it("declares exactly the six refactor roles with unique localIds", () => {
    const localIds = REFACTOR_ROLE_PACK.characters.map((c) => c.localId)
    expect(localIds).toEqual([...REFACTOR_ROLES])
    expect(new Set(localIds).size).toBe(localIds.length)
  })

  it("gives every role the fields the agent.turn path needs", () => {
    for (const ch of REFACTOR_ROLE_PACK.characters) {
      expect(ch.name.length).toBeGreaterThan(0)
      expect(ch.avatarColor).toMatch(/^oklch\(/)
      expect(ch.systemPrompt.length).toBeGreaterThan(40)
      // No role may carry `permissionMode`. `resolveSendOptions` falls back
      // session → mode → character → appSettings, so a character-level
      // `bypassPermissions` also applies to ordinary interactive chat with
      // that character — where there is no permission ceiling. The headless
      // bypass belongs to the agent.turn node, not to the persona.
      expect(ch.permissionMode).toBeUndefined()
      expect(ch.allowedTools?.length ?? 0).toBeGreaterThan(0)
      // Plugin skills are referenced via pluginSkillIds (not skillIds).
      expect(ch.pluginSkillIds?.length ?? 0).toBeGreaterThan(0)
      expect(ch.skillIds ?? []).toHaveLength(0)
    }
  })

  it("only references plugin skills it declares in requires", () => {
    const required = new Set(REFACTOR_ROLE_PACK.requires?.pluginSkillIds ?? [])
    for (const ch of REFACTOR_ROLE_PACK.characters) {
      for (const id of ch.pluginSkillIds ?? []) {
        expect(id.startsWith(`${PLUGIN_ID}:`)).toBe(true)
        expect(required.has(id)).toBe(true)
      }
    }
  })

  it("projects role → runtime character id the way the host namespaces packs", () => {
    expect(roleCharacterId("refactorer")).toBe(
      `cognia-pack:${PLUGIN_ID}:${REFACTOR_PACK_ID}:refactorer`
    )
  })

  it("only edit-capable roles get write tools; read roles do not", () => {
    const byRole = Object.fromEntries(
      REFACTOR_ROLE_PACK.characters.map((c) => [c.localId, c.allowedTools ?? []])
    )
    expect(byRole.refactorer).toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]))
    expect(byRole.tester).toEqual(expect.arrayContaining(["Edit", "Write"]))
    expect(byRole.analyst).not.toContain("Edit")
    expect(byRole.reviewer).not.toContain("Edit")
    expect(byRole.architect).not.toContain("Bash")
  })

  it("declares the five backing skills under requires.pluginSkillIds", () => {
    expect(REFACTOR_ROLE_PACK.requires?.pluginSkillIds).toEqual(
      expect.arrayContaining([
        packSkillId("go-clean-architecture"),
        packSkillId("refactor-playbook"),
        packSkillId("go-testing"),
        packSkillId("backend-infra"),
        packSkillId("dependency-upgrade"),
      ])
    )
  })
})
