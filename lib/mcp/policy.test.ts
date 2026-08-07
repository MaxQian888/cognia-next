import type { McpServer } from "@cognia/agent-config-types"

import { evaluateMcpPolicy, validateMcpRemoteEgress } from "./policy"

const server = (trust: "legacy" | "pending" | "trusted" | "blocked"): McpServer =>
  ({
    id: "mcp_a",
    name: "a",
    transport: "stdio",
    config: { command: "node" },
    enabled: true,
    trust: { state: trust },
    createdAt: 1,
    updatedAt: 1,
  }) as McpServer

describe("MCP policy", () => {
  it("keeps legacy definitions compatible but blocks pending non-interactive execution", () => {
    expect(
      evaluateMcpPolicy({ server: server("legacy"), surface: "chat", interactive: false })
    ).toMatchObject({ decision: "allow" })
    expect(
      evaluateMcpPolicy({ server: server("pending"), surface: "workflow", interactive: false })
    ).toMatchObject({ decision: "deny" })
    expect(
      evaluateMcpPolicy({ server: server("pending"), surface: "settings", interactive: true })
    ).toMatchObject({ decision: "ask" })
  })

  it("honors fingerprint-scoped non-interactive grants", () => {
    expect(
      evaluateMcpPolicy({
        server: server("pending"),
        surface: "workflow",
        interactive: false,
        grant: { serverId: "mcp_a", fingerprint: "fp", tools: ["read"] },
        fingerprint: "fp",
        toolName: "read",
      })
    ).toMatchObject({ decision: "allow" })
  })

  it("requires HTTPS and blocks private/reserved destinations by default", () => {
    expect(() => validateMcpRemoteEgress("http://example.com/mcp", false)).toThrow("HTTPS")
    for (const url of [
      "https://127.0.0.1/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.2/mcp",
      "https://[::1]/mcp",
      "https://[::ffff:7f00:1]/mcp",
      "https://service.local/mcp",
      "https://192.0.2.10/mcp",
      "https://198.18.0.1/mcp",
      "https://198.51.100.20/mcp",
      "https://203.0.113.2/mcp",
    ]) {
      expect(() => validateMcpRemoteEgress(url, false)).toThrow("private")
    }
    expect(validateMcpRemoteEgress("https://example.com/mcp", false).href).toBe(
      "https://example.com/mcp"
    )
  })

  it("allows an explicitly reviewed private-network exception", () => {
    expect(validateMcpRemoteEgress("http://127.0.0.1:8787/mcp", true).hostname).toBe("127.0.0.1")
  })
})
