import { mcpServerToAcpConfig, resolveAcpMcpServers } from "./resolve-acp-mcp-servers"
import type { McpServer } from "@/lib/claude/types"
import { listMcpServers } from "@/lib/db/mcp-servers"

jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: jest.fn(),
}))

const mockList = listMcpServers as jest.MockedFunction<typeof listMcpServers>

function server(
  partial: Partial<McpServer> & Pick<McpServer, "id" | "name" | "transport">
): McpServer {
  return { config: {}, enabled: true, ...partial } as McpServer
}

describe("mcpServerToAcpConfig", () => {
  it("projects a stdio server with args + env", () => {
    const s = server({
      id: "1",
      name: "fs",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "fs"], env: { TOKEN: "abc" } },
    })
    expect(mcpServerToAcpConfig(s)).toEqual({
      name: "fs",
      command: "npx",
      args: ["-y", "fs"],
      env: [{ name: "TOKEN", value: "abc" }],
    })
  })

  it("defaults stdio args to [] and omits empty env", () => {
    const s = server({ id: "1", name: "fs", transport: "stdio", config: { command: "fs-bin" } })
    expect(mcpServerToAcpConfig(s)).toEqual({ name: "fs", command: "fs-bin", args: [] })
  })

  it("drops a stdio server with no command", () => {
    const s = server({ id: "1", name: "bad", transport: "stdio", config: { args: ["x"] } })
    expect(mcpServerToAcpConfig(s)).toBeNull()
  })

  it("projects an http server with headers", () => {
    const s = server({
      id: "2",
      name: "remote",
      transport: "http",
      config: { url: "https://mcp.example", headers: { Authorization: "Bearer t" } },
    })
    expect(mcpServerToAcpConfig(s)).toEqual({
      type: "http",
      name: "remote",
      url: "https://mcp.example",
      headers: [{ name: "Authorization", value: "Bearer t" }],
    })
  })

  it("projects an sse server", () => {
    const s = server({
      id: "3",
      name: "sse",
      transport: "sse",
      config: { url: "https://sse.example" },
    })
    expect(mcpServerToAcpConfig(s)).toEqual({
      type: "sse",
      name: "sse",
      url: "https://sse.example",
    })
  })

  it("drops a remote server with no url", () => {
    const s = server({ id: "2", name: "bad", transport: "http", config: {} })
    expect(mcpServerToAcpConfig(s)).toBeNull()
  })

  it("drops an unknown transport", () => {
    const s = server({ id: "9", name: "weird", transport: "in-process" as never, config: {} })
    expect(mcpServerToAcpConfig(s)).toBeNull()
  })
})

describe("resolveAcpMcpServers", () => {
  beforeEach(() => mockList.mockReset())

  it("returns [] for an empty id list without hitting the store", async () => {
    expect(await resolveAcpMcpServers([])).toEqual([])
    expect(mockList).not.toHaveBeenCalled()
  })

  it("resolves by id and skips disabled / unwanted / malformed servers", async () => {
    mockList.mockResolvedValue([
      server({ id: "a", name: "fs", transport: "stdio", config: { command: "fs" } }),
      server({
        id: "b",
        name: "off",
        transport: "stdio",
        enabled: false,
        config: { command: "x" },
      }),
      server({ id: "c", name: "other", transport: "stdio", config: { command: "y" } }),
      server({ id: "d", name: "bad", transport: "stdio", config: {} }),
    ])
    const out = await resolveAcpMcpServers(["a", "d"])
    expect(out).toEqual([{ name: "fs", command: "fs", args: [] }])
  })

  it("falls back to matching by name", async () => {
    mockList.mockResolvedValue([
      server({ id: "a", name: "remote", transport: "http", config: { url: "https://x" } }),
    ])
    const out = await resolveAcpMcpServers(["remote"])
    expect(out).toEqual([{ type: "http", name: "remote", url: "https://x" }])
  })

  it("dedupes servers that share a name (ACP keys by name)", async () => {
    mockList.mockResolvedValue([
      server({ id: "a", name: "dup", transport: "stdio", config: { command: "first" } }),
      server({ id: "b", name: "dup", transport: "stdio", config: { command: "second" } }),
    ])
    const out = await resolveAcpMcpServers(["a", "b"])
    expect(out).toEqual([{ name: "dup", command: "first", args: [] }])
  })
})
