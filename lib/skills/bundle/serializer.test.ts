import { loadBundle } from "./loader"
import { serializeSkillBundle, serializeSkillBundleBatch } from "./serializer"
import type { Skill, SkillResource } from "@cognia/agent-config-types"
import JSZip from "jszip"

const skill: Skill = {
  id: "skill_portable",
  slug: "portable-skill",
  name: "可移植技能",
  description: "Portable skill.",
  compatibility: "Requires git.",
  metadata: { custom: "value" },
  invocationPolicy: "explicit",
  frontmatterExtensions: { "future-field": { enabled: true } },
  codexOpenAiYaml: "interface:\n  display_name: Portable\nunknown_key: keep\n",
  content: "# Instructions\n\nDo the work.",
  allowedTools: ["Read", "Write"],
  createdAt: 1,
  updatedAt: 1,
}

const resources: SkillResource[] = [
  {
    id: "text",
    skillId: skill.id,
    kind: "reference",
    name: "guide.md",
    path: "references/guide.md",
    content: "guide",
    encoding: "utf-8",
    inline: true,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "binary",
    skillId: skill.id,
    kind: "asset",
    name: "pixel.bin",
    path: "assets/pixel.bin",
    content: "AAEC/w==",
    encoding: "base64",
    size: 4,
    createdAt: 1,
    updatedAt: 1,
  },
]

describe("skill bundle serializer", () => {
  it("roundtrips standard fields, unknown extensions, Codex YAML, and resource bytes", async () => {
    const serialized = await serializeSkillBundle({ skill, resources })
    expect(serialized.filename).toBe("portable-skill.zip")
    const loaded = await loadBundle({ kind: "zip-blob", bytes: serialized.bytes })
    expect(loaded.draft).toMatchObject({
      slug: "portable-skill",
      name: "可移植技能",
      compatibility: "Requires git.",
      metadata: expect.objectContaining({ custom: "value" }),
      invocationPolicy: "explicit",
      frontmatterExtensions: { "future-field": { enabled: true } },
      codexOpenAiYaml: skill.codexOpenAiYaml,
    })
    expect(loaded.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "references/guide.md", content: "guide" }),
        expect.objectContaining({
          path: "assets/pixel.bin",
          content: "AAEC/w==",
          encoding: "base64",
        }),
      ])
    )
    expect(
      loaded.resources.find((resource) => resource.path === "references/guide.md")?.inline
    ).toBe(true)
  })

  it("writes one root directory per skill in a dated batch archive", async () => {
    const result = await serializeSkillBundleBatch(
      [{ skill, resources }],
      new Date("2026-08-08T00:00:00.000Z")
    )
    const zip = await JSZip.loadAsync(result.bytes)
    expect(result.filename).toBe("cognia-skills-2026-08-08.zip")
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining([
        "portable-skill/SKILL.md",
        "portable-skill/agents/openai.yaml",
        "portable-skill/assets/pixel.bin",
      ])
    )
  })

  it("rejects non-portable exports without a description", async () => {
    await expect(
      serializeSkillBundle({ skill: { ...skill, description: undefined }, resources: [] })
    ).rejects.toThrow(/Description is required/)
  })

  it("rejects duplicate roots in a batch instead of overwriting entries", async () => {
    await expect(
      serializeSkillBundleBatch([
        { skill, resources: [] },
        { skill: { ...skill, id: "other" }, resources: [] },
      ])
    ).rejects.toThrow(/Duplicate skill slug/)
  })
})
