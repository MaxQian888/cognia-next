import { nameFromFilename, parseSkillMarkdown, serializeSkill, skillFilename } from "./skills-io"

describe("serializeSkill", () => {
  it("produces frontmatter with name and content body", () => {
    const md = serializeSkill({
      name: "Cite sources",
      description: "Every claim cites a source.",
      content: "When stating a fact, name the source.",
    })
    expect(md).toMatch(/^---\n/)
    expect(md).toContain("name: Cite sources")
    expect(md).toContain("description: Every claim cites a source.")
    expect(md).toContain("When stating a fact, name the source.")
  })

  it("emits allowed-tools and tags as YAML arrays", () => {
    const md = serializeSkill({
      name: "Researcher",
      content: "...",
      allowedTools: ["WebSearch", "Read"],
      tags: ["accuracy", "style"],
    })
    expect(md).toContain("allowed-tools:")
    expect(md).toContain("- WebSearch")
    expect(md).toContain("- Read")
    expect(md).toContain("tags:")
    expect(md).toContain("- accuracy")
  })

  it("skips empty arrays", () => {
    const md = serializeSkill({
      name: "Plain",
      content: "body",
      allowedTools: [],
      tags: [],
    })
    expect(md).not.toContain("allowed-tools")
    expect(md).not.toContain("tags")
  })
})

describe("parseSkillMarkdown", () => {
  it("roundtrips through serializeSkill", () => {
    const original = {
      name: "Step-by-step reasoning",
      description: "Show numbered reasoning before the answer.",
      content: "Walk through your reasoning as a numbered list.",
      allowedTools: ["Read"],
      tags: ["reasoning"],
    }
    const md = serializeSkill(original)
    const { draft, warnings } = parseSkillMarkdown(md)
    expect(warnings).toEqual([])
    expect(draft.name).toBe(original.name)
    expect(draft.description).toBe(original.description)
    expect(draft.allowedTools).toEqual(original.allowedTools)
    expect(draft.tags).toEqual(original.tags)
    expect(draft.content.trim()).toBe(original.content.trim())
  })

  it("accepts comma-separated lists for allowed-tools and tags", () => {
    const md = `---
name: Comma-list
allowed-tools: WebSearch, Read
tags: a, b, c
---

body content
`
    const { draft } = parseSkillMarkdown(md)
    expect(draft.allowedTools).toEqual(["WebSearch", "Read"])
    expect(draft.tags).toEqual(["a", "b", "c"])
  })

  it("falls back to fallbackName when frontmatter has no name", () => {
    const md = "no frontmatter at all, just a body"
    const { draft, warnings } = parseSkillMarkdown(md, {
      fallbackName: "from-filename",
    })
    expect(draft.name).toBe("from-filename")
    expect(warnings.length).toBeGreaterThan(0)
    expect(draft.content).toBe("no frontmatter at all, just a body")
  })

  it("throws when there is no name and no fallback", () => {
    expect(() => parseSkillMarkdown("body only")).toThrow(/missing a name/i)
  })

  it("throws when content body is empty", () => {
    const md = `---
name: Empty
---

`
    expect(() => parseSkillMarkdown(md)).toThrow(/no content body/i)
  })
})

describe("filename helpers", () => {
  it("converts skill names to kebab-case .md filenames", () => {
    expect(skillFilename("Cite Sources")).toBe("cite-sources.md")
    expect(skillFilename("Step / by / step")).toBe("step-by-step.md")
    expect(skillFilename("  edge??!! case  ")).toBe("edge-case.md")
  })

  it("recovers a name from a filename", () => {
    expect(nameFromFilename("cite-sources.md")).toBe("cite sources")
    expect(nameFromFilename("step_by_step.markdown")).toBe("step by step")
  })
})
