import { ZHIHU_ROLE_PACK, ZHIHU_ROLES, zhihuRoleCharacterId } from "./pack"
import { PLUGIN_ID, ROLE_PACK_ID, packSkillId } from "../ids"

describe("ZHIHU_ROLE_PACK", () => {
  it("declares exactly the five pipeline roles with unique localIds", () => {
    const localIds = ZHIHU_ROLE_PACK.characters.map((c) => c.localId)
    expect(localIds).toEqual([...ZHIHU_ROLES])
    expect(new Set(localIds).size).toBe(localIds.length)
  })

  it("gives every role a name, oklch avatar, system prompt, and a plugin skill", () => {
    for (const ch of ZHIHU_ROLE_PACK.characters) {
      expect(ch.name.length).toBeGreaterThan(0)
      expect(ch.avatarColor).toMatch(/^oklch\(/)
      expect(ch.systemPrompt.length).toBeGreaterThan(40)
      // Skills are referenced via pluginSkillIds, never the Dexie skillIds.
      expect(ch.pluginSkillIds?.length ?? 0).toBeGreaterThan(0)
      expect(ch.skillIds ?? []).toHaveLength(0)
      // No hard-coded MCP server ids — roles inherit all enabled servers.
      expect(ch.mcpServerIds).toBeUndefined()
    }
  })

  it("only references plugin skills declared in requires.pluginSkillIds", () => {
    const required = new Set(ZHIHU_ROLE_PACK.requires?.pluginSkillIds ?? [])
    for (const ch of ZHIHU_ROLE_PACK.characters) {
      for (const id of ch.pluginSkillIds ?? []) {
        expect(id.startsWith(`${PLUGIN_ID}:`)).toBe(true)
        expect(required.has(id)).toBe(true)
      }
    }
  })

  it("wires the writer to the zhihu-answer-writer skill", () => {
    const writer = ZHIHU_ROLE_PACK.characters.find((c) => c.localId === "writer")
    expect(writer?.pluginSkillIds).toContain(packSkillId("zhihu-answer-writer"))
  })

  it("gives the polisher both the de-AI and illustration skills", () => {
    const polisher = ZHIHU_ROLE_PACK.characters.find((c) => c.localId === "polisher")
    expect(polisher?.pluginSkillIds).toEqual(
      expect.arrayContaining([packSkillId("de-ai-humanizer"), packSkillId("zhihu-illustration")])
    )
  })

  it("projects role → runtime character id the way the host namespaces packs", () => {
    expect(zhihuRoleCharacterId("scout")).toBe(`cognia-pack:${PLUGIN_ID}:${ROLE_PACK_ID}:scout`)
  })
})
