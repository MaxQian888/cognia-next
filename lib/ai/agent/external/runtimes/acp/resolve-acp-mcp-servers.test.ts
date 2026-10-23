import {
  mcpServerToAcpConfig,
  resolveAcpMcpServers,
  resolvedMcpServerMapToAcpConfigs,
} from "./resolve-acp-mcp-servers"
import type { McpServer } from "@cognia/agent-config-types"
import { buildMcpServerMap, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { buildRunMcpServerMap } from "@/lib/mcp/run-server-map"

jest.mock("@/lib/db/mcp-servers", () => ({
  ...jest.requireActual("@/lib/db/mcp-servers"),
  listEnabledMcpServers: jest.fn(),
}))
jest.mock("@/lib/mcp/run-server-map", () => ({
  buildRunMcpServerMap: jest.fn(),
}))

const mockList = listEnabledMcpServers as jest.MockedFunction<typeof listEnabledMcpServers>
const mockBuildMap = buildRunMcpServerMap as jest.MockedFunction<typeof buildRunMcpServerMap>

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
  beforeEach(() => {
    mockList.mockReset()
    mockBuildMap.mockReset()
    // The real projection, minus keyring access: SecretRefs become lease values.
    mockBuildMap.mockImplementation(async (servers) =>
      buildMcpServerMap(
        servers.map((candidate) => ({
          ...candidate,
          config: JSON.parse(
            JSON.stringify(candidate.config, (_key, value) =>
              value && typeof value === "object" && "secretRef" in value
                ? `resolved:${value.secretRef}`
                : value
            )
          ),
        }))
      )
    )
  })

  it("returns [] for an empty id list without hitting the store", async () => {
    expect(await resolveAcpMcpServers([])).toEqual([])
    expect(mockList).not.toHaveBeenCalled()
  })

  it("selects from the run's live servers and skips unwanted / malformed ones", async () => {
    mockList.mockResolvedValue([
      server({ id: "a", name: "fs", transport: "stdio", config: { command: "fs" } }),
      server({ id: "c", name: "other", transport: "stdio", config: { command: "y" } }),
      server({ id: "d", name: "bad", transport: "stdio", config: {} }),
    ])
    const out = await resolveAcpMcpServers(["a", "d", "off"], { scope: { projectId: "p1" } })
    expect(out).toEqual([{ name: "fs", command: "fs", args: [] }])
    // Trust, enablement and the workspace overlay are the canonical lister's job.
    expect(mockList).toHaveBeenCalledWith({ projectId: "p1" })
  })

  it("never forwards a server the canonical lister withheld (pending, blocked, workspace-off)", async () => {
    mockList.mockResolvedValue([])
    expect(await resolveAcpMcpServers(["pending", "blocked", "workspace-off"])).toEqual([])
    expect(mockBuildMap).not.toHaveBeenCalled()
  })

  it("falls back to matching by name", async () => {
    mockList.mockResolvedValue([
      server({ id: "a", name: "remote", transport: "http", config: { url: "https://x.example" } }),
    ])
    const out = await resolveAcpMcpServers(["remote"])
    expect(out).toEqual([{ type: "http", name: "remote", url: "https://x.example" }])
  })

  it("dedupes servers that share a name (ACP keys by name)", async () => {
    mockList.mockResolvedValue([
      server({ id: "a", name: "dup", transport: "stdio", config: { command: "first" } }),
      server({ id: "b", name: "dup", transport: "stdio", config: { command: "second" } }),
    ])
    const out = await resolveAcpMcpServers(["a", "b"])
    expect(out).toEqual([{ name: "dup", command: "first", args: [] }])
  })

  it("forwards SecretRef credentials resolved instead of dropping them", async () => {
    mockList.mockResolvedValue([
      server({
        id: "a",
        name: "local",
        transport: "stdio",
        config: {
          command: "node",
          args: ["bridge.mjs", { secretRef: "arg" }],
          env: { TOKEN: { secretRef: "env" } },
        } as never,
      }),
      server({
        id: "b",
        name: "remote",
        transport: "http",
        config: {
          url: "https://mcp.example",
          headers: { Authorization: { secretRef: "header" } },
        } as never,
      }),
    ])
    const out = await resolveAcpMcpServers(["a", "b"])
    expect(mockBuildMap).toHaveBeenCalledTimes(1)
    expect(out).toEqual([
      {
        name: "local",
        command: "node",
        args: ["bridge.mjs", "resolved:arg"],
        env: [{ name: "TOKEN", value: "resolved:env" }],
      },
      {
        type: "http",
        name: "remote",
        url: "https://mcp.example",
        headers: [{ name: "Authorization", value: "resolved:header" }],
      },
    ])
  })

  it.each([
    ["an exact deny", { disallowedTools: ["delete"] }],
    ["a glob deny", { disallowedToolPatterns: ["write_*"] }],
    ["a portable ask rule", { toolPermissionRules: [{ name: "send", decision: "ask" as const }] }],
  ])("refuses a server with %s the child cannot enforce", async (_label, rules) => {
    mockList.mockResolvedValue([
      server({ id: "a", name: "guarded", transport: "stdio", config: { command: "x" }, ...rules }),
    ])
    await expect(resolveAcpMcpServers(["a"])).rejects.toThrow(
      "cannot enforce the tool restrictions of MCP server guarded"
    )
    expect(mockBuildMap).not.toHaveBeenCalled()
  })

  it("ignores restrictions on servers that were not assigned", async () => {
    mockList.mockResolvedValue([
      server({ id: "a", name: "fs", transport: "stdio", config: { command: "fs" } }),
      server({
        id: "b",
        name: "guarded",
        transport: "stdio",
        config: { command: "x" },
        disallowedTools: ["delete"],
      }),
    ])
    expect(await resolveAcpMcpServers(["a"])).toEqual([{ name: "fs", command: "fs", args: [] }])
  })
})

describe("resolvedMcpServerMapToAcpConfigs", () => {
  it("preserves the resolved turn subset and transient credentials without rereading storage", () => {
    mockList.mockClear()
    expect(
      resolvedMcpServerMapToAcpConfigs({
        local: { command: "/usr/bin/node", args: ["/bridge.mjs"], env: { TOKEN: "lease" } },
        remote: {
          type: "http",
          url: "https://mcp.example",
          headers: { Authorization: "Bearer lease" },
        },
      })
    ).toEqual([
      {
        name: "local",
        command: "/usr/bin/node",
        args: ["/bridge.mjs"],
        env: [{ name: "TOKEN", value: "lease" }],
      },
      {
        name: "remote",
        type: "http",
        url: "https://mcp.example",
        headers: [{ name: "Authorization", value: "Bearer lease" }],
      },
    ])
    expect(mockList).not.toHaveBeenCalled()
    expect(resolvedMcpServerMapToAcpConfigs()).toEqual([])
  })
  it("fails visibly instead of silently dropping an unforwardable assigned server", () => {
    expect(() => resolvedMcpServerMapToAcpConfigs({ internal: { type: "sdk" } })).toThrow(
      "cannot be forwarded"
    )
    expect(() => resolvedMcpServerMapToAcpConfigs({ broken: { type: "http" } })).toThrow(
      "incomplete"
    )
  })

  it("refuses servers the turn restricts per tool instead of forwarding them whole", () => {
    const servers = {
      fs: { command: "fs" },
      search: { type: "http", url: "https://mcp.example" },
    }
    for (const restrictions of [
      { mcpToolAllowlist: { search: ["query"] } },
      { disallowedTools: ["Bash", "mcp__search__drop"] },
      { toolPermissionRules: [{ tool: "mcp__search__send" }] },
    ]) {
      expect(() => resolvedMcpServerMapToAcpConfigs(servers, restrictions)).toThrow(
        "cannot enforce the tool restrictions of MCP server search"
      )
    }
    expect(
      resolvedMcpServerMapToAcpConfigs(servers, { disallowedTools: ["mcp__searchy__x", "Bash"] })
    ).toHaveLength(2)
  })
})
