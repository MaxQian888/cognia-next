import {
  buildModeMcpToolAllowlist,
  filterServersByModeSelection,
  modeMcpSelection,
  resolveModeMcpDeniedToolNames,
} from "./mode-selection"

describe("modeMcpSelection", () => {
  it("returns undefined when the mode does not restrict MCP", () => {
    expect(modeMcpSelection(undefined)).toBeUndefined()
    expect(modeMcpSelection({ id: "m" })).toBeUndefined()
    expect(modeMcpSelection({ mcpTools: [] })).toBeUndefined()
    expect(modeMcpSelection({ mcpTools: [{ serverId: "a", toolName: " " }] })).toBeUndefined()
  })

  it("keeps well-formed references and drops malformed ones", () => {
    expect(
      modeMcpSelection({
        mcpTools: [{ serverId: "a", toolName: "query", displayName: "Q" }, { serverId: 1 }, null],
      })
    ).toEqual([{ serverId: "a", toolName: "query", displayName: "Q" }])
  })
})

describe("filterServersByModeSelection", () => {
  it("keeps only the servers the selection names", () => {
    expect(
      filterServersByModeSelection(
        [{ id: "a" }, { id: "b" }, { id: "c" }],
        [
          { serverId: "c", toolName: "x" },
          { serverId: "a", toolName: "y" },
        ]
      )
    ).toEqual([{ id: "a" }, { id: "c" }])
  })
})

describe("resolveModeMcpDeniedToolNames", () => {
  it("denies every known unselected tool on each selected server, namespaced", async () => {
    const tools: Record<string, string[]> = { a: ["query", "crawl"], b: ["read", "write", "rm"] }
    const denied = await resolveModeMcpDeniedToolNames(
      [
        { id: "a", name: "search" },
        { id: "b", name: "files" },
      ],
      [
        { serverId: "a", toolName: "query" },
        { serverId: "b", toolName: "read" },
        { serverId: "b", toolName: "write" },
      ],
      async (serverId) => tools[serverId] ?? []
    )
    expect(denied).toEqual(["mcp__files__rm", "mcp__search__crawl"])
  })

  it("does not touch servers the selection does not name", async () => {
    const load = jest.fn(async () => ["x"])
    expect(
      await resolveModeMcpDeniedToolNames(
        [{ id: "other", name: "other" }],
        [{ serverId: "a", toolName: "q" }],
        load
      )
    ).toEqual([])
    expect(load).not.toHaveBeenCalled()
  })
})

describe("buildModeMcpToolAllowlist", () => {
  it("keys each attached server by its runtime name with its picked tools", () => {
    expect(
      buildModeMcpToolAllowlist(
        [
          { id: "a", name: "search" },
          { id: "b", name: "files" },
          { id: "c", name: "unpicked" },
        ],
        [
          { serverId: "a", toolName: "query" },
          { serverId: "b", toolName: "write" },
          { serverId: "b", toolName: "read" },
          { serverId: "a", toolName: "query" },
        ]
      )
    ).toEqual({ search: ["query"], files: ["read", "write"] })
  })
})
