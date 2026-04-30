import { ROO_CODE_AGENT } from "./roo-code"

describe("roo-code adapter — metadata", () => {
  it("is a read-only JSON adapter", () => {
    expect(ROO_CODE_AGENT.id).toBe("roo-code")
    expect(ROO_CODE_AGENT.writable).toBe(false)
    expect(ROO_CODE_AGENT.format).toBe("json")
  })
})

describe("roo-code adapter — parse", () => {
  it("returns [] for null / non-object", () => {
    expect(ROO_CODE_AGENT.parse(null)).toEqual([])
    expect(ROO_CODE_AGENT.parse(42)).toEqual([])
    expect(ROO_CODE_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcpServers is absent or not an object", () => {
    expect(ROO_CODE_AGENT.parse({})).toEqual([])
    expect(ROO_CODE_AGENT.parse({ mcpServers: 1 })).toEqual([])
  })

  it("collapses streamable-http to http", () => {
    const drafts = ROO_CODE_AGENT.parse({
      mcpServers: { x: { type: "streamable-http", url: "https://x/mcp" } },
    })
    expect(drafts[0].transport).toBe("http")
  })

  it("preserves opaque fields like alwaysAllow / disabled / watchPaths", () => {
    const drafts = ROO_CODE_AGENT.parse({
      mcpServers: {
        f: {
          command: "x",
          alwaysAllow: ["read"],
          disabled: true,
          watchPaths: ["/x"],
          timeout: 5,
        },
      },
    })
    expect(drafts[0].config).toMatchObject({
      command: "x",
      alwaysAllow: ["read"],
      disabled: true,
      watchPaths: ["/x"],
      timeout: 5,
    })
  })

  it("drops malformed entries", () => {
    const drafts = ROO_CODE_AGENT.parse({
      mcpServers: { good: { command: "g" }, bad: { random: 1 } },
    })
    expect(drafts.map((d) => d.name)).toEqual(["good"])
  })
})

describe("roo-code adapter — project", () => {
  it("throws because the globalStorage path is not stable", () => {
    expect(() => ROO_CODE_AGENT.project(null, [])).toThrow(/read-only/)
    expect(() => ROO_CODE_AGENT.project({ mcpServers: {} }, [])).toThrow(/globalStorage/)
  })
})
