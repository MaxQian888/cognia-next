import { CLINE_AGENT } from "./cline"

describe("cline adapter — metadata", () => {
  it("is a read-only JSON adapter", () => {
    expect(CLINE_AGENT.id).toBe("cline")
    expect(CLINE_AGENT.writable).toBe(false)
    expect(CLINE_AGENT.format).toBe("json")
  })
})

describe("cline adapter — parse", () => {
  it("returns [] for null / non-object input", () => {
    expect(CLINE_AGENT.parse(null)).toEqual([])
    expect(CLINE_AGENT.parse("hi")).toEqual([])
    expect(CLINE_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcpServers is absent or not an object", () => {
    expect(CLINE_AGENT.parse({})).toEqual([])
    expect(CLINE_AGENT.parse({ mcpServers: 7 })).toEqual([])
  })

  it("parses stdio entries", () => {
    const drafts = CLINE_AGENT.parse({
      mcpServers: { fs: { command: "npx", args: ["fs"] } },
    })
    expect(drafts).toEqual([
      { name: "fs", transport: "stdio", config: { command: "npx", args: ["fs"] } },
    ])
  })

  it("parses HTTP entries with explicit type", () => {
    const drafts = CLINE_AGENT.parse({
      mcpServers: { api: { type: "http", url: "https://x/mcp" } },
    })
    expect(drafts[0].transport).toBe("http")
  })

  it("preserves cline-only fields (alwaysAllow, disabled) as opaque keys", () => {
    const drafts = CLINE_AGENT.parse({
      mcpServers: {
        foo: {
          command: "f",
          alwaysAllow: ["read"],
          disabled: false,
        },
      },
    })
    expect(drafts[0].config).toMatchObject({ command: "f", alwaysAllow: ["read"], disabled: false })
  })

  it("skips entries that can't be normalized", () => {
    const drafts = CLINE_AGENT.parse({
      mcpServers: { good: { command: "x" }, bad: { random: "k" } },
    })
    expect(drafts.map((d) => d.name)).toEqual(["good"])
  })
})

describe("cline adapter — project", () => {
  it("throws because the globalStorage path is not stable", () => {
    expect(() => CLINE_AGENT.project(null, [])).toThrow(/read-only/)
    expect(() => CLINE_AGENT.project({}, [])).toThrow(/globalStorage/)
  })
})
