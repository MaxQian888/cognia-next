import {
  nameFromFilename,
  parseSkillMarkdown,
  resolveSkillMarkdown,
  serializeSkill,
  skillFilename,
} from "./skills-io"
import { isTauri } from "@/lib/tauri"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

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

describe("resolveSkillMarkdown (M4)", () => {
  const mIsTauri = isTauri as jest.Mock

  beforeEach(() => {
    mIsTauri.mockReturnValue(false)
  })

  it("returns the inline body verbatim for inline source", async () => {
    const def: PluginSkillDef = {
      id: "code-review",
      name: "Code Review",
      description: "Review code.",
      source: {
        kind: "inline",
        markdown: "# Code Review\n\nDo it carefully.",
      },
    }
    const body = await resolveSkillMarkdown(def)
    expect(body).toBe("# Code Review\n\nDo it carefully.")
  })

  it("returns undefined for anthropic-managed source", async () => {
    const def: PluginSkillDef = {
      id: "managed",
      name: "Managed",
      description: "Anthropic managed.",
      source: {
        kind: "anthropic-managed",
        containerSkillId: "container-1",
        version: "1.0.0",
      },
    }
    const body = await resolveSkillMarkdown(def)
    expect(body).toBeUndefined()
  })

  it("drops local-folder in browser mode and warns instead of polluting the prompt", async () => {
    const def: PluginSkillDef = {
      id: "local-test",
      name: "Local Test",
      description: "Local folder skill.",
      source: { kind: "local-folder", path: "/tmp/skills/local-test" },
    }
    mIsTauri.mockReturnValue(false)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const body = await resolveSkillMarkdown(def)
    expect(body).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect((warn.mock.calls[0]?.[0] as string).includes("local-test")).toBe(true)
    warn.mockRestore()
  })

  it("drops the skill with a warning when the local-folder read fails in Tauri", async () => {
    const def: PluginSkillDef = {
      id: "broken",
      name: "Broken",
      description: "Local folder skill that fails to read.",
      source: { kind: "local-folder", path: "/no/such/path" },
    }
    mIsTauri.mockReturnValue(true)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    // In jest/jsdom there's no @tauri-apps/plugin-fs runtime — the dynamic
    // import throws which is caught and reported via console.warn; the
    // resolver returns undefined so the renderer drops the skill instead
    // of injecting an `[skill "…": failed to read]` placeholder into the
    // system prompt.
    const body = await resolveSkillMarkdown(def)
    expect(body).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("parseSkillMarkdown — frontmatter warnings", () => {
  it("warns on unknown frontmatter keys", () => {
    const { warnings } = parseSkillMarkdown("---\nname: A\nfoo: bar\nbaz: qux\n---\nBody.")
    const joined = warnings.join("\n")
    expect(joined).toMatch(/"foo"/)
    expect(joined).toMatch(/"baz"/)
  })

  it("flags Claude Code dynamic-trigger keys (priority, promptSignals, etc.) as known-but-unmodelled", () => {
    const { warnings } = parseSkillMarkdown(
      "---\nname: A\npriority: 10\npromptSignals:\n  phrases: [x]\n---\nBody."
    )
    const joined = warnings.join("\n")
    expect(joined).toMatch(/priority/)
    expect(joined).toMatch(/promptSignals/)
    expect(joined).toMatch(/dynamic-activation/i)
  })

  it("does not warn for known keys including the allowedTools camelCase alias", () => {
    const { warnings } = parseSkillMarkdown(
      "---\nname: A\nallowedTools: [Read]\nversion: '1.0'\nauthor: Jane\nlicense: MIT\n---\nBody."
    )
    expect(warnings).toEqual([])
  })
})
