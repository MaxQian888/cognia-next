import { parseBundleManifest } from "./parse"

const ANTHROPIC_SKILL_MD = `---
name: Code Review
description: Reviews the staged diff
allowed-tools: [Read, Bash]
tags: [quality]
category: development
version: 1.2.3
---
Review the staged diff and flag issues by severity.
`

const CODEX_OPENAI_YAML = `
interface:
  display_name: Code Review (Codex)
  short_description: Reviews code changes
  brand_color: "#0e639c"
policy:
  allow_implicit_invocation: false
dependencies:
  tools:
    - type: mcp
      value: lark-cli
      description: Lark CLI tool
`

describe("parseBundleManifest", () => {
  it("returns an anthropic draft when only SKILL.md is supplied", () => {
    const result = parseBundleManifest({ skillMd: ANTHROPIC_SKILL_MD })
    expect(result.flavor).toBe("anthropic")
    expect(result.codexMeta).toBeUndefined()
    expect(result.draft.name).toBe("Code Review")
    expect(result.draft.allowedTools).toEqual(["Read", "Bash"])
    expect(result.draft.tags).toEqual(["quality"])
    expect(result.draft.category).toBe("development")
    expect(result.draft.version).toBe("1.2.3")
    expect(result.draft.content).toContain("Review the staged diff")
    expect(result.nonFatalValidationErrors).toEqual([])
  })

  it("flips flavor to codex and folds in openai.yaml warnings", () => {
    const result = parseBundleManifest({
      skillMd: ANTHROPIC_SKILL_MD,
      openaiYaml: CODEX_OPENAI_YAML,
    })
    expect(result.flavor).toBe("codex")
    expect(result.codexMeta?.interface?.displayName).toBe("Code Review (Codex)")
    expect(result.codexMeta?.policy?.allowImplicitInvocation).toBe(false)
    expect(result.codexMeta?.toolDependencies[0]?.value).toBe("lark-cli")
    expect(result.warnings.some((w) => w.includes("implicit invocation"))).toBe(true)
    expect(result.warnings.some((w) => w.includes("MCP dependencies"))).toBe(true)
  })

  it("overrides name with Codex display_name only when SKILL.md fell back to the supplied name", () => {
    const noName = `---\ndescription: noop\n---\nBody.\n`
    const overridden = parseBundleManifest({
      skillMd: noName,
      openaiYaml: CODEX_OPENAI_YAML,
      fallbackName: "fallback-slug",
    })
    expect(overridden.draft.name).toBe("Code Review (Codex)")

    // SKILL.md provided a name → Codex display name does NOT win.
    const kept = parseBundleManifest({
      skillMd: ANTHROPIC_SKILL_MD,
      openaiYaml: CODEX_OPENAI_YAML,
      fallbackName: "fallback-slug",
    })
    expect(kept.draft.name).toBe("Code Review")
  })

  it("throws on fatal validation errors (missing name)", () => {
    const noName = `---\ndescription: x\n---\nBody.\n`
    // parseSkillMarkdown throws its own "missing a name" before our validator
    // gets a turn — either source counts as "refused".
    expect(() => parseBundleManifest({ skillMd: noName })).toThrow(/refused|missing a name/i)
  })

  it("throws on fatal validation errors (missing content)", () => {
    const noBody = `---\nname: ok\ndescription: x\n---\n`
    // parseSkillMarkdown throws its own "no content body" before our validator
    // gets a turn — either source counts as "refused", which is what callers
    // need.
    expect(() => parseBundleManifest({ skillMd: noBody })).toThrow(/refused|content body/i)
  })

  it("surfaces non-fatal validation errors on the result so the row can persist with status=error", () => {
    const longName = "a".repeat(80)
    const md = `---\nname: ${longName}\n---\nBody.\n`
    const result = parseBundleManifest({ skillMd: md })
    expect(result.nonFatalValidationErrors.map((e) => e.code)).toContain("name-too-long")
  })

  it("propagates SKILL.md parse warnings", () => {
    const md = `---\nname: ok\nunknownKey: oops\n---\nBody.\n`
    const result = parseBundleManifest({ skillMd: md })
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("survives an empty openai.yaml without warnings", () => {
    const result = parseBundleManifest({
      skillMd: ANTHROPIC_SKILL_MD,
      openaiYaml: "",
    })
    expect(result.flavor).toBe("codex")
    expect(result.codexMeta).toBeDefined()
    expect(result.codexMeta?.warnings).toEqual([])
    expect(result.warnings.filter((w) => w.includes("YAML"))).toEqual([])
  })
})
