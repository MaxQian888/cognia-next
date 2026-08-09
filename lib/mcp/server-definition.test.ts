import type { McpServer } from "@cognia/agent-config-types"

import {
  McpDefinitionError,
  assertUniqueMcpNamespace,
  fingerprintMcpDefinition,
  normalizeMcpNamespace,
  toMcpServerSummary,
  validateMcpDefinition,
} from "./server-definition"

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: "mcp_a",
  name: "github",
  displayName: "GitHub",
  transport: "stdio",
  config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  enabled: false,
  schemaVersion: 1,
  revision: 1,
  credentialVersion: 0,
  origin: "manual",
  trust: { state: "pending" },
  createdAt: 1,
  updatedAt: 2,
  ...over,
})

describe("MCP server definitions", () => {
  it("normalizes namespaces and rejects case-insensitive duplicates", () => {
    expect(normalizeMcpNamespace("  GitHub  ")).toBe("github")
    expect(() => assertUniqueMcpNamespace("GITHUB", [server()])).toThrow(McpDefinitionError)
  })

  it("validates transport-specific required fields", () => {
    expect(() => validateMcpDefinition(server({ config: { command: "" } }))).toThrow("command")
    expect(() =>
      validateMcpDefinition(server({ transport: "http", config: { url: "not a url" } }))
    ).toThrow("URL")
    expect(validateMcpDefinition(server()).name).toBe("github")
  })

  it("fingerprints executable shape without secret material", () => {
    const first = fingerprintMcpDefinition(
      server({ config: { command: "node", env: { TOKEN: { secretRef: "mcp/mcp_a/env/TOKEN" } } } })
    )
    const rotated = fingerprintMcpDefinition(
      server({
        credentialVersion: 9,
        config: { command: "node", env: { TOKEN: { secretRef: "mcp/mcp_a/env/TOKEN" } } },
      })
    )
    const changed = fingerprintMcpDefinition(server({ config: { command: "python" } }))
    expect(rotated).toBe(first)
    expect(changed).not.toBe(first)
    expect(first).not.toContain("TOKEN")
  })

  it("fingerprints normalized server-level deny rules", () => {
    const base = fingerprintMcpDefinition(server({ disallowedTools: undefined }))
    const empty = fingerprintMcpDefinition(server({ disallowedTools: [] }))
    const denied = fingerprintMcpDefinition(
      server({ disallowedTools: [" browser_run_code_unsafe ", "browser_evaluate"] })
    )
    const reordered = fingerprintMcpDefinition(
      server({ disallowedTools: ["browser_evaluate", "browser_run_code_unsafe"] })
    )

    expect(empty).toBe(base)
    expect(reordered).toBe(denied)
    expect(denied).not.toBe(base)
  })

  it("projects only redacted fields to mobile", () => {
    expect(
      toMcpServerSummary(
        server({ config: { command: "node", env: { TOKEN: { secretRef: "secret" } } } })
      )
    ).toEqual({
      id: "mcp_a",
      displayName: "GitHub",
      transport: "stdio",
      enabled: false,
      trustState: "pending",
      updatedAt: 2,
    })
  })
})
