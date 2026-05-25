import { ZHIHU_SKILLS } from "./definitions"
import { PLUGIN_ID, packSkillId } from "../ids"

describe("ZHIHU_SKILLS", () => {
  it("ships the six pipeline playbooks", () => {
    expect(ZHIHU_SKILLS).toHaveLength(6)
    const ids = ZHIHU_SKILLS.map((s) => s.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        packSkillId("hot-topic-scout"),
        packSkillId("topic-selection"),
        packSkillId("deep-research"),
        packSkillId("zhihu-answer-writer"),
        packSkillId("de-ai-humanizer"),
        packSkillId("zhihu-illustration"),
      ])
    )
  })

  it("self-namespaces every skill id and keeps them unique", () => {
    const ids = ZHIHU_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of ZHIHU_SKILLS) {
      expect(s.id.startsWith(`${PLUGIN_ID}:`)).toBe(true)
    }
  })

  it("uses inline markdown (bundled, browser-safe) with real content", () => {
    for (const s of ZHIHU_SKILLS) {
      expect(s.source.kind).toBe("inline")
      if (s.source.kind === "inline") {
        expect(s.source.markdown.length).toBeGreaterThan(200)
        // The body should not leak broken relative reference links.
        expect(s.source.markdown).not.toMatch(/\]\(references\//)
      }
      expect(s.name.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
      expect(s.scope).toBe("character")
    }
  })

  it("keeps the writer playbook's four-gate discipline", () => {
    const writer = ZHIHU_SKILLS.find((s) => s.id === packSkillId("zhihu-answer-writer"))
    const md = writer?.source.kind === "inline" ? writer.source.markdown : ""
    expect(md).toContain("确认 ①")
    expect(md).toContain("确认 ②")
    expect(md).toContain("确认 ③")
    expect(md).toContain("确认 ④")
  })
})
