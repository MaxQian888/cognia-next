import {
  DISPATCH_AGENT_TOOL_NAME,
  DISPATCH_AGENT_PLUGIN_ID,
  buildDispatchAgentSchema,
  buildDispatchAgentManifestEntry,
  parseDispatchAgentArgs,
  type DispatchAgentAvailableSubagent,
} from "./dispatch-agent-tool"

const available: DispatchAgentAvailableSubagent[] = [
  { id: "researcher", description: "Researches things" },
  { id: "coder", description: "Writes code" },
]

describe("dispatch-agent-tool — schema & manifest", () => {
  it("constrains subagentId to an enum when subagents are available", () => {
    const schema = buildDispatchAgentSchema(available) as {
      properties: {
        subagentId: { enum?: string[] }
        dispatches: { items: { properties: { subagentId: { enum?: string[] } } } }
      }
    }
    expect(schema.properties.subagentId.enum).toEqual(["researcher", "coder"])
    expect(schema.properties.dispatches.items.properties.subagentId.enum).toEqual([
      "researcher",
      "coder",
    ])
  })

  it("omits the enum when no subagents are available", () => {
    const schema = buildDispatchAgentSchema([]) as {
      properties: { subagentId: { enum?: string[] } }
    }
    expect(schema.properties.subagentId.enum).toBeUndefined()
  })

  it("builds a manifest entry with the synthetic plugin id and lists agents", () => {
    const entry = buildDispatchAgentManifestEntry(available)
    expect(entry.name).toBe(DISPATCH_AGENT_TOOL_NAME)
    expect(entry.pluginId).toBe(DISPATCH_AGENT_PLUGIN_ID)
    expect(entry.description).toContain("researcher")
    expect(entry.description).toContain("coder")
  })

  it("disables the round-trip timeout (subagents run their own bounded loop)", () => {
    expect(buildDispatchAgentManifestEntry(available).timeoutMs).toBe(0)
  })
})

describe("dispatch-agent-tool — parseDispatchAgentArgs", () => {
  it("parses the single form with defaults (toolsEnabled true, background false)", () => {
    const r = parseDispatchAgentArgs({ subagentId: "coder", prompt: "do it" })
    expect(r).toEqual({
      mode: "dispatch",
      dispatches: [{ subagentId: "coder", prompt: "do it", toolsEnabled: true, background: false }],
    })
  })

  it("accepts the Claude Code-style `subagent_type` as an alias for subagentId", () => {
    const r = parseDispatchAgentArgs({ subagent_type: "coder", prompt: "do it" })
    expect(r).toEqual({
      mode: "dispatch",
      dispatches: [{ subagentId: "coder", prompt: "do it", toolsEnabled: true, background: false }],
    })
  })

  it("honors explicit toolsEnabled=false and background=true", () => {
    const r = parseDispatchAgentArgs({
      subagentId: "coder",
      prompt: "x",
      toolsEnabled: false,
      background: true,
    })
    expect(r).toMatchObject({
      mode: "dispatch",
      dispatches: [{ toolsEnabled: false, background: true }],
    })
  })

  it("parses the parallel form, dropping malformed entries", () => {
    const r = parseDispatchAgentArgs({
      dispatches: [
        { subagentId: "a", prompt: "one" },
        { subagentId: "b" }, // missing prompt → dropped
        { prompt: "no id" }, // missing id → dropped
        { subagentId: "c", prompt: "two", background: true },
      ],
    })
    expect(r.mode).toBe("dispatch")
    if (r.mode === "dispatch") {
      expect(r.dispatches.map((d) => d.subagentId)).toEqual(["a", "c"])
      expect(r.dispatches[1].background).toBe(true)
    }
  })

  it("errors when the parallel array has no valid entries", () => {
    const r = parseDispatchAgentArgs({ dispatches: [{ subagentId: "a" }] })
    expect(r.mode).toBe("error")
  })

  it("parses the collect form and trims the runId", () => {
    const r = parseDispatchAgentArgs({ collect: "  run-123  " })
    expect(r).toEqual({ mode: "collect", runId: "run-123" })
  })

  it("collect wins over a dispatch payload", () => {
    const r = parseDispatchAgentArgs({ collect: "run-1", subagentId: "a", prompt: "x" })
    expect(r.mode).toBe("collect")
  })

  it("errors on empty / unusable args", () => {
    expect(parseDispatchAgentArgs({}).mode).toBe("error")
    expect(parseDispatchAgentArgs({ subagentId: "  ", prompt: "x" }).mode).toBe("error")
    expect(parseDispatchAgentArgs({ subagentId: "a", prompt: "   " }).mode).toBe("error")
  })
})
