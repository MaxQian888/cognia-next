import { parseMarkdownAgent, buildMarkdownAgents, markdownAgentsToSdkMap } from "./markdown-agents"

const VALID = `---
description: Reviews code for bugs
model: opus
allowed-tools: Read, Grep, Glob
---
You are a meticulous code reviewer. Find real bugs.`

describe("parseMarkdownAgent", () => {
  it("parses frontmatter + body into an AgentDefinition", () => {
    const r = parseMarkdownAgent("reviewer", VALID)
    expect("def" in r).toBe(true)
    if (!("def" in r)) return
    expect(r.def.description).toBe("Reviews code for bugs")
    expect(r.def.model).toBe("opus")
    expect(r.def.tools).toEqual(["Read", "Grep", "Glob"])
    expect(r.def.prompt).toBe("You are a meticulous code reviewer. Find real bugs.")
  })

  it("parses a `provider` override (cross-provider subagent)", () => {
    const r = parseMarkdownAgent(
      "rv",
      `---\ndescription: x\nprovider: anthropic\nmodel: sonnet\n---\nbody`
    )
    if (!("def" in r)) throw new Error("expected def")
    expect(r.def.provider).toBe("anthropic")
    expect(r.def.model).toBe("sonnet")
  })

  it("omits provider when absent", () => {
    const r = parseMarkdownAgent("rv", `---\ndescription: x\n---\nbody`)
    if (!("def" in r)) throw new Error("expected def")
    expect(r.def.provider).toBeUndefined()
  })

  it("accepts a `tools` array and `disallowed-tools`", () => {
    const md = `---
description: x
tools:
  - Read
  - Bash
disallowed-tools: Write
---
body`
    const r = parseMarkdownAgent("a", md)
    if (!("def" in r)) throw new Error("expected def")
    expect(r.def.tools).toEqual(["Read", "Bash"])
    expect(r.def.disallowedTools).toEqual(["Write"])
  })

  it("parses an `external-preset-id` backing (Thread A2)", () => {
    const r = parseMarkdownAgent(
      "a",
      `---\ndescription: x\nexternal-preset-id: claude-code\n---\nbody`
    )
    if (!("def" in r)) throw new Error("expected def")
    expect(r.def.externalPresetId).toBe("claude-code")
  })

  it("accepts the camelCase `externalPresetId` alias", () => {
    const r = parseMarkdownAgent("a", `---\ndescription: x\nexternalPresetId: codex\n---\nbody`)
    if (!("def" in r)) throw new Error("expected def")
    expect(r.def.externalPresetId).toBe("codex")
  })

  it("parses `mcp-server-ids` (and the camelCase alias) into a list", () => {
    const kebab = parseMarkdownAgent(
      "a",
      `---\ndescription: x\nmcp-server-ids:\n  - github\n  - linear\n---\nbody`
    )
    if (!("def" in kebab)) throw new Error("expected def")
    expect(kebab.def.mcpServerIds).toEqual(["github", "linear"])

    const camel = parseMarkdownAgent(
      "a",
      `---\ndescription: x\nmcpServerIds:\n  - github\n---\nbody`
    )
    if (!("def" in camel)) throw new Error("expected def")
    expect(camel.def.mcpServerIds).toEqual(["github"])
  })

  it("errors on a missing description", () => {
    const r = parseMarkdownAgent("a", `---\nmodel: opus\n---\nbody`)
    expect("error" in r).toBe(true)
  })

  it("errors on an empty body", () => {
    const r = parseMarkdownAgent("a", `---\ndescription: x\n---\n   `)
    expect("error" in r).toBe(true)
  })

  it("omits optional fields when absent", () => {
    const r = parseMarkdownAgent("a", `---\ndescription: x\n---\nhello`)
    if (!("def" in r)) throw new Error("expected def")
    expect(r.def.model).toBeUndefined()
    expect(r.def.tools).toBeUndefined()
    expect(r.def.disallowedTools).toBeUndefined()
    expect(r.def.externalPresetId).toBeUndefined()
    expect(r.def.mcpServerIds).toBeUndefined()
  })
})

describe("buildMarkdownAgents", () => {
  it("merges files, later overriding earlier by id, collecting warnings", () => {
    const { agents, warnings } = buildMarkdownAgents([
      { id: "reviewer", content: `---\ndescription: global\n---\nglobal prompt` },
      { id: "reviewer", content: VALID },
      { id: "broken", content: `---\nmodel: opus\n---\nno description` },
    ])
    expect(agents.reviewer.description).toBe("Reviews code for bugs")
    expect(Object.keys(agents)).toEqual(["reviewer"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/broken/)
  })
})

describe("markdownAgentsToSdkMap", () => {
  it("projects to the SendOptions.agents shape", () => {
    const { agents } = buildMarkdownAgents([{ id: "reviewer", content: VALID }])
    const map = markdownAgentsToSdkMap(agents)
    expect(map.reviewer.description).toBe("Reviews code for bugs")
    expect(map.reviewer.prompt).toContain("code reviewer")
  })
})
