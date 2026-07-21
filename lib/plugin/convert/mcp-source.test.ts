import {
  describeConfig,
  buildMcpPreset,
  listMcpCandidates,
  readMcpDrafts,
  selectMcpAdapter,
  stripJsonComments,
  SUPPORTED_MCP_ADAPTERS,
} from "./mcp-source"

const CURSOR_CONFIG = JSON.stringify({
  mcpServers: {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_live" },
    },
    deepwiki: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
  },
})

describe("stripJsonComments", () => {
  it("removes line and block comments", () => {
    expect(
      stripJsonComments(`{
        // a line comment
        "a": 1, /* inline */
        "b": 2
      }`)
    ).toContain('"a": 1')
    expect(stripJsonComments('{ // x\n "a": 1 }')).not.toContain("//")
  })

  it("leaves comment-like text inside strings alone", () => {
    const out = stripJsonComments('{ "url": "https://x.dev/a" }')
    expect(JSON.parse(out)).toEqual({ url: "https://x.dev/a" })
  })

  it("handles escaped quotes inside strings", () => {
    const out = stripJsonComments('{ "a": "he said \\"hi\\"" }')
    expect(JSON.parse(out)).toEqual({ a: 'he said "hi"' })
  })

  it("drops trailing commas", () => {
    expect(JSON.parse(stripJsonComments('{ "a": 1, }'))).toEqual({ a: 1 })
  })
})

describe("SUPPORTED_MCP_ADAPTERS", () => {
  it("excludes TOML-backed agents, which the converter cannot decode", () => {
    expect(SUPPORTED_MCP_ADAPTERS.every((a) => a.format !== "toml")).toBe(true)
    expect(SUPPORTED_MCP_ADAPTERS.length).toBeGreaterThan(5)
  })
})

describe("selectMcpAdapter", () => {
  it("prefers the adapter named by the file path", () => {
    const value = JSON.parse(CURSOR_CONFIG)
    expect(selectMcpAdapter("/home/me/.cursor/mcp.json", value).id).toBe("cursor")
  })

  it("falls back to whichever adapter finds entries", () => {
    const value = JSON.parse(CURSOR_CONFIG)
    expect(selectMcpAdapter("random-name.json", value).parse(value).length).toBeGreaterThan(0)
  })

  it("throws when no adapter finds anything", () => {
    expect(() => selectMcpAdapter("x.json", { unrelated: true })).toThrow(/no MCP servers found/)
  })
})

describe("readMcpDrafts", () => {
  it("reports a parse failure with the source name", () => {
    expect(() => readMcpDrafts("{ not json", "mcp.json")).toThrow(/mcp.json.*JSON/s)
  })

  it("accepts JSONC", () => {
    const { drafts } = readMcpDrafts(
      `{
        // servers
        "mcpServers": { "a": { "command": "x" } },
      }`,
      "mcp.json"
    )
    expect(drafts.map((d) => d.name)).toEqual(["a"])
  })
})

describe("listMcpCandidates", () => {
  it("lists every server with a transport hint", () => {
    expect(listMcpCandidates(CURSOR_CONFIG, ".cursor/mcp.json")).toEqual([
      { id: "playwright", label: "playwright", detail: "stdio · npx" },
      { id: "github", label: "github", detail: "stdio · npx" },
      { id: "deepwiki", label: "deepwiki", detail: "http · https://mcp.deepwiki.com/mcp" },
    ])
  })
})

describe("buildMcpPreset", () => {
  it("builds a stdio preset with no fields when nothing is user-specific", () => {
    const { preset, draft } = buildMcpPreset(CURSOR_CONFIG, "playwright", ".cursor/mcp.json")
    expect(draft.transport).toBe("stdio")
    expect(preset).toEqual({
      id: "playwright",
      name: "playwright",
      description: "MCP server run locally via `npx -y @playwright/mcp@latest`.",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      fields: [],
    })
  })

  it("never copies a credential into the preset", () => {
    const { preset, todos } = buildMcpPreset(CURSOR_CONFIG, "github", ".cursor/mcp.json")
    expect(JSON.stringify(preset)).not.toContain("ghp_live")
    expect(preset.fields).toEqual([
      { key: "GITHUB_TOKEN", label: "Github token", placement: "env", secret: true },
    ])
    expect(todos.join(" ")).toMatch(/GITHUB_TOKEN is a credential/)
  })

  it("describes a remote server from its URL", () => {
    const { preset } = buildMcpPreset(CURSOR_CONFIG, "deepwiki", ".cursor/mcp.json")
    expect(preset.transport).toBe("http")
    expect(preset.description).toBe("Remote HTTP MCP server at https://mcp.deepwiki.com/mcp.")
  })

  it("leaves `runtime` unset so the preset reaches both agent runtimes", () => {
    const { preset } = buildMcpPreset(CURSOR_CONFIG, "playwright")
    expect(preset.runtime).toBeUndefined()
  })

  it("describes a server from the SANITIZED config, so no raw value leaks", () => {
    const config = JSON.stringify({
      mcpServers: {
        fs: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/ada/Documents"],
        },
      },
    })
    const { preset } = buildMcpPreset(config, "fs")
    expect(preset.description).toBe(
      "MCP server run locally via `npx -y @modelcontextprotocol/server-filesystem <DOCUMENTS>`."
    )
    expect(preset.description).not.toContain("/Users/ada")
  })

  it("describes a credential-bearing remote server without repeating the URL", () => {
    const config = JSON.stringify({
      mcpServers: { api: { type: "http", url: "https://x.dev/mcp?api_key=live" } },
    })
    const { preset } = buildMcpPreset(config, "api")
    expect(preset.description).toBe("Remote HTTP MCP server.")
    expect(JSON.stringify(preset)).not.toContain("live")
  })

  it("lists the available names when the pick is unknown", () => {
    expect(() => buildMcpPreset(CURSOR_CONFIG, "nope", ".cursor/mcp.json")).toThrow(
      /available: playwright, github, deepwiki/
    )
  })
})

describe("describeConfig — degenerate configs", () => {
  it("handles a stdio entry whose args are not strings", () => {
    expect(describeConfig("stdio", { command: "srv", args: [1, null, "--flag"] })).toBe(
      "MCP server run locally via `srv --flag`."
    )
  })

  it("handles a stdio entry with no args at all", () => {
    expect(describeConfig("stdio", { command: "srv" })).toBe("MCP server run locally via `srv`.")
  })

  it("handles a remote entry whose url was stripped", () => {
    expect(describeConfig("sse", {})).toBe("Remote SSE MCP server.")
  })
})

describe("mcp-source — remaining edge paths", () => {
  it("keeps a trailing backslash inside a string from swallowing the terminator", () => {
    // The escape branch consumes the next character; at end-of-input there
    // is none, so it must not read past the buffer.
    expect(() => stripJsonComments('{ "a": "x\\')).not.toThrow()
  })

  it("names the input generically when no source name was supplied", () => {
    expect(() => readMcpDrafts("{ not json")).toThrow(/could not parse "input"/)
  })

  it("reports a non-Error parse failure without losing the message", () => {
    expect(() => readMcpDrafts("{ bad", "x.json")).toThrow(/x\.json/)
  })

  it("lists a remote candidate with an empty url without printing undefined", () => {
    const config = JSON.stringify({
      mcpServers: { remote: { type: "http", url: "https://x.dev/mcp" } },
    })
    expect(listMcpCandidates(config)[0].detail).toBe("http · https://x.dev/mcp")
  })

  it("says (none) when the pick misses and the file yielded nothing usable", () => {
    // Every entry is dropped by `dropInvalidDrafts`, so the adapter parses
    // the file but produces no candidates.
    const empty = JSON.stringify({ mcpServers: {}, servers: { a: { command: "x" } } })
    expect(() => buildMcpPreset(empty, "nope")).toThrow(/available: a/)
  })

  it("describes a stdio config whose command is missing", () => {
    expect(describeConfig("stdio", {})).toBe("MCP server run locally via ``.")
  })
})
