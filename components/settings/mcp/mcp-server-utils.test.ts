import {
  objectToKvRows,
  kvRowsToObject,
  summarizeServer,
  cloneServerDraft,
  groupServers,
  MCP_TRANSPORT_VALUES,
} from "./mcp-server-utils"
import type { McpServer } from "@cognia/agent-config-types"

function srv(patch: Partial<McpServer>): McpServer {
  return {
    id: "mcp_1",
    name: "github",
    transport: "stdio",
    config: { command: "npx", args: ["-y", "server-github"] },
    enabled: true,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as McpServer
}

describe("objectToKvRows / kvRowsToObject", () => {
  it("round-trips a record, coercing values to strings", () => {
    const rows = objectToKvRows({ A: "1", B: 2 })
    expect(rows).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ])
    expect(kvRowsToObject(rows)).toEqual({ A: "1", B: "2" })
  })

  it("returns [] for non-objects", () => {
    expect(objectToKvRows(null)).toEqual([])
    expect(objectToKvRows("nope")).toEqual([])
  })

  it("drops rows with blank keys when serializing", () => {
    expect(
      kvRowsToObject([
        { key: "  ", value: "x" },
        { key: "K", value: "v" },
      ])
    ).toEqual({ K: "v" })
  })
})

describe("summarizeServer", () => {
  it("joins command + args for stdio", () => {
    expect(summarizeServer(srv({}))).toBe("npx -y server-github")
  })
  it("shows the url for http/sse", () => {
    expect(summarizeServer(srv({ transport: "http", config: { url: "https://x/mcp" } }))).toBe(
      "https://x/mcp"
    )
  })
  it("returns empty string when a remote server has no url (caller supplies fallback)", () => {
    expect(summarizeServer(srv({ transport: "sse", config: {} }))).toBe("")
  })
  it("returns empty string when a stdio server has no command", () => {
    expect(summarizeServer(srv({ transport: "stdio", config: {} }))).toBe("")
  })
  it("accepts the minimal transport/config shape (e.g. an import draft)", () => {
    expect(summarizeServer({ transport: "http", config: { url: "https://d/mcp" } })).toBe(
      "https://d/mcp"
    )
  })
})

describe("cloneServerDraft", () => {
  it("deep-copies config, appsEnabled, and disallowed tools", () => {
    const original = srv({
      appsEnabled: { "claude-code": true },
      disallowedTools: ["browser_run_code_unsafe"],
    })
    const draft = cloneServerDraft(original)
    expect(draft.name).toBe("github copy")
    expect(draft.config).toEqual(original.config)
    expect(draft.config).not.toBe(original.config)
    expect(draft.appsEnabled).toEqual({ "claude-code": true })
    expect(draft.disallowedTools).toEqual(["browser_run_code_unsafe"])

    draft.disallowedTools!.push("browser_evaluate")
    expect(original.disallowedTools).toEqual(["browser_run_code_unsafe"])
  })

  it("defaults missing disallowed tools to an empty list", () => {
    expect(cloneServerDraft(srv({ disallowedTools: undefined })).disallowedTools).toEqual([])
  })
})

describe("MCP_TRANSPORT_VALUES", () => {
  it("lists the three transports", () => {
    expect(MCP_TRANSPORT_VALUES).toEqual(["stdio", "sse", "http"])
  })
})

describe("groupServers", () => {
  const a = srv({ id: "a", name: "alpha", transport: "stdio", enabled: true })
  const b = srv({ id: "b", name: "bravo", transport: "http", enabled: false })
  const c = srv({ id: "c", name: "charlie", transport: "stdio", enabled: true })
  const all = [a, b, c]
  const none = () => false

  it("none → single header-less group, favorites floated to top", () => {
    const groups = groupServers(all, "none", (id) => id === "c")
    expect(groups).toHaveLength(1)
    expect(groups[0].headerKind).toBe("none")
    expect(groups[0].servers.map((s) => s.id)).toEqual(["c", "a", "b"])
  })

  it("transport → one non-empty section per transport in stable order", () => {
    const groups = groupServers(all, "transport", none)
    expect(groups.map((g) => g.headerValue)).toEqual(["stdio", "http"])
    expect(groups[0].servers.map((s) => s.id)).toEqual(["a", "c"])
  })

  it("status → enabled then disabled, dropping empties", () => {
    const groups = groupServers(all, "status", none)
    expect(groups.map((g) => g.headerValue)).toEqual(["enabled", "disabled"])
    expect(groups[0].servers.map((s) => s.id)).toEqual(["a", "c"])
    expect(groups[1].servers.map((s) => s.id)).toEqual(["b"])
  })
})
