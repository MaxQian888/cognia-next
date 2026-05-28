import { parseCodexOpenaiYaml } from "./codex-yaml"

describe("parseCodexOpenaiYaml", () => {
  it("returns empty result for empty / null / undefined inputs", () => {
    expect(parseCodexOpenaiYaml("")).toEqual({ toolDependencies: [], warnings: [] })
    expect(parseCodexOpenaiYaml("---")).toEqual({ toolDependencies: [], warnings: [] })
    expect(parseCodexOpenaiYaml("null")).toEqual({ toolDependencies: [], warnings: [] })
  })

  it("rejects non-mapping roots with a warning", () => {
    const result = parseCodexOpenaiYaml("- a\n- b\n")
    expect(result.toolDependencies).toEqual([])
    expect(result.warnings.some((w) => w.includes("must be a mapping"))).toBe(true)
  })

  it("captures yaml syntax errors as warnings rather than throwing", () => {
    const result = parseCodexOpenaiYaml("interface:\n  display_name: [unclosed")
    expect(result.toolDependencies).toEqual([])
    expect(result.warnings.some((w) => w.includes("failed to parse"))).toBe(true)
  })

  it("extracts the full Codex interface block", () => {
    const yaml = `
interface:
  display_name: Code Review
  short_description: Reviews code changes
  icon_small: icons/small.png
  icon_large: icons/large.png
  brand_color: "#0e639c"
  default_prompt: Review the staged changes.
`
    const result = parseCodexOpenaiYaml(yaml)
    expect(result.interface).toEqual({
      displayName: "Code Review",
      shortDescription: "Reviews code changes",
      iconSmall: "icons/small.png",
      iconLarge: "icons/large.png",
      brandColor: "#0e639c",
      defaultPrompt: "Review the staged changes.",
    })
    expect(result.warnings).toEqual([])
  })

  it("extracts the policy block", () => {
    const result = parseCodexOpenaiYaml(`
policy:
  allow_implicit_invocation: false
`)
    expect(result.policy).toEqual({ allowImplicitInvocation: false })
  })

  it("extracts an MCP tool dependency", () => {
    const result = parseCodexOpenaiYaml(`
dependencies:
  tools:
    - type: mcp
      value: lark-cli
      description: Lark / Feishu CLI tool
      transport: streamable_http
      url: https://example.com/mcp
`)
    expect(result.toolDependencies).toEqual([
      {
        type: "mcp",
        value: "lark-cli",
        description: "Lark / Feishu CLI tool",
        transport: "streamable_http",
        url: "https://example.com/mcp",
      },
    ])
  })

  it("warns on unknown top-level keys but keeps the rest", () => {
    const result = parseCodexOpenaiYaml(`
interface:
  display_name: Foo
extras:
  bonus: yes
`)
    expect(result.interface?.displayName).toBe("Foo")
    expect(result.warnings.some((w) => w.includes("Unknown top-level key"))).toBe(true)
  })

  it("warns on unknown nested keys", () => {
    const result = parseCodexOpenaiYaml(`
interface:
  display_name: Foo
  funky_field: 42
policy:
  allow_implicit_invocation: true
  another_one: ok
`)
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("interface.funky_field"),
        expect.stringContaining("policy.another_one"),
      ])
    )
  })

  it("warns and skips tool entries that are missing the required `type` field", () => {
    const result = parseCodexOpenaiYaml(`
dependencies:
  tools:
    - value: orphan
    - type: mcp
      value: ok
`)
    expect(result.toolDependencies).toEqual([
      { type: "mcp", value: "ok", description: undefined, transport: undefined, url: undefined },
    ])
    expect(result.warnings.some((w) => w.includes("missing required 'type'"))).toBe(true)
  })

  it("warns when dependencies.tools is not an array", () => {
    const result = parseCodexOpenaiYaml(`
dependencies:
  tools:
    type: mcp
`)
    expect(result.toolDependencies).toEqual([])
    expect(result.warnings.some((w) => w.includes("must be an array"))).toBe(true)
  })

  it("warns when interface is not a mapping", () => {
    const result = parseCodexOpenaiYaml(`interface: hello`)
    expect(result.interface).toBeUndefined()
    expect(result.warnings.some((w) => w.includes("interface must be a mapping"))).toBe(true)
  })

  it("treats empty/null string fields as undefined (so renderers can fallback cleanly)", () => {
    const result = parseCodexOpenaiYaml(`
interface:
  display_name: ""
  short_description: Cool
`)
    expect(result.interface?.displayName).toBeUndefined()
    expect(result.interface?.shortDescription).toBe("Cool")
  })
})
