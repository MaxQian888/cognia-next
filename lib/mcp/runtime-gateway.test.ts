/** @jest-environment node */
import type { McpServer } from "@cognia/agent-config-types"

const mockAppendMcpAuditLog = jest.fn(
  async (_draft: { phase: string; [key: string]: unknown }) => undefined
)
jest.mock("@/lib/db/mcp-audit-log", () => ({
  appendMcpAuditLog: (draft: { phase: string; [key: string]: unknown }) =>
    mockAppendMcpAuditLog(draft),
}))

const mockCapabilityCache = new Map<string, unknown>()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    mcpCapabilityCache: {
      get: (id: string) => Promise.resolve(mockCapabilityCache.get(id)),
      put: (row: { id: string }) => {
        mockCapabilityCache.set(row.id, row)
        return Promise.resolve(row.id)
      },
      where: () => ({
        equals: () => ({
          delete: () => {
            mockCapabilityCache.clear()
            return Promise.resolve()
          },
        }),
      }),
    },
  }),
}))

import { McpRuntimeGateway } from "./runtime-gateway"

const server = (id = "mcp-a"): McpServer =>
  ({
    id,
    name: id,
    transport: "stdio",
    config: { command: "fixture" },
    enabled: true,
    trust: { state: "trusted" },
    revision: 1,
    credentialVersion: 0,
    createdAt: 1,
    updatedAt: 1,
  }) as McpServer

function fixtureOpen(delayMs = 0) {
  let active = 0
  let maximum = 0
  const callTool = jest.fn(async () => ({ content: [{ type: "text", text: "ok" }] }))
  const readResource = jest.fn(async () => ({
    contents: [{ uri: "issue://1", mimeType: "text/plain", text: "Issue 1" }],
  }))
  const getPrompt = jest.fn(async () => ({
    description: "Review",
    messages: [{ role: "user" as const, content: { type: "text", text: "Review it" } }],
  }))
  const close = jest.fn(async () => undefined)
  const open = jest.fn(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    active -= 1
    return {
      client: {
        callTool,
        listTools: async () => ({ tools: [{ name: "do" }] }),
        listResources: async () => ({ resources: [] }),
        listPrompts: async () => ({ prompts: [] }),
        readResource,
        getPrompt,
      },
      transport: {},
      close,
    }
  })
  return { open: open as never, callTool, readResource, getPrompt, close, maximum: () => maximum }
}

describe("MCP Runtime Gateway", () => {
  beforeEach(() => {
    mockAppendMcpAuditLog.mockClear()
    mockCapabilityCache.clear()
  })

  it("reuses one initialized connection within an unchanged scope", async () => {
    const fixture = fixtureOpen()
    const gateway = new McpRuntimeGateway({ open: fixture.open, retryDelayMs: 0 })
    const input = { scopeId: "run-1", server: server(), surface: "workflow" as const }
    await gateway.invoke({ ...input, toolName: "do" })
    await gateway.invoke({ ...input, toolName: "do" })
    expect(fixture.open).toHaveBeenCalledTimes(1)
    expect(fixture.callTool).toHaveBeenCalledTimes(2)
    await gateway.closeScope("run-1")
    expect(fixture.close).toHaveBeenCalledTimes(1)
  })

  it("never exceeds four simultaneous cold connections", async () => {
    const fixture = fixtureOpen(10)
    const gateway = new McpRuntimeGateway({ open: fixture.open, maxConcurrentConnects: 4 })
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        gateway.invoke({
          scopeId: "load",
          server: server(`mcp-${index}`),
          surface: "workflow",
          toolName: "do",
        })
      )
    )
    expect(fixture.maximum()).toBeLessThanOrEqual(4)
    await gateway.closeScope("load")
  })

  it("reports connection, warm-reuse, cache, retry, and call counters", async () => {
    const fixture = fixtureOpen()
    const gateway = new McpRuntimeGateway({ open: fixture.open })
    const input = { scopeId: "metrics", server: server("metrics"), surface: "workflow" as const }
    const updates: number[] = []
    const unsubscribe = gateway.subscribeMetrics((metrics) => updates.push(metrics.toolCalls))

    await gateway.discover(input)
    await gateway.discover(input)
    await gateway.invoke({ ...input, toolName: "do" })

    expect(gateway.getMetricsSnapshot()).toEqual(
      expect.objectContaining({
        connectionAttempts: 1,
        successfulConnections: 1,
        failedConnections: 0,
        warmReuses: 1,
        capabilityCacheHits: 1,
        retries: 0,
        toolCalls: 1,
      })
    )
    expect(updates.length).toBeGreaterThan(0)
    unsubscribe()
    await gateway.closeScope("metrics")
  })

  it("does not retry a tool call", async () => {
    const fixture = fixtureOpen()
    fixture.callTool.mockRejectedValueOnce(new Error("side effect failed"))
    const gateway = new McpRuntimeGateway({ open: fixture.open })
    await expect(
      gateway.invoke({
        scopeId: "run",
        server: server(),
        surface: "workflow",
        toolName: "do",
      })
    ).rejects.toThrow("side effect failed")
    expect(fixture.callTool).toHaveBeenCalledTimes(1)
  })

  it("refreshes, reconnects, and retries once only after an explicit 401", async () => {
    const first = fixtureOpen()
    first.callTool.mockRejectedValueOnce(Object.assign(new Error("HTTP 401"), { status: 401 }))
    const second = fixtureOpen()
    const open = jest.fn().mockImplementationOnce(first.open).mockImplementationOnce(second.open)
    const refreshAuth = jest.fn(async () => ({
      server: { ...server(), credentialVersion: 1 },
      authProvider: { token: "new" },
    }))
    const gateway = new McpRuntimeGateway({ open: open as never })

    await expect(
      gateway.invoke({
        scopeId: "refresh",
        server: server(),
        surface: "workflow",
        toolName: "write",
        refreshAuth,
      })
    ).resolves.toEqual({ isError: false, content: [{ type: "text", text: "ok" }] })
    expect(refreshAuth).toHaveBeenCalledTimes(1)
    expect(first.callTool).toHaveBeenCalledTimes(1)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.callTool).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[1][1].authProvider).toEqual({ token: "new" })
  })

  it("never refreshes or retries an ambiguous timeout", async () => {
    const fixture = fixtureOpen()
    fixture.callTool.mockRejectedValueOnce(new Error("HTTP request timeout"))
    const refreshAuth = jest.fn()
    const gateway = new McpRuntimeGateway({ open: fixture.open })
    await expect(
      gateway.invoke({
        scopeId: "timeout",
        server: server(),
        surface: "workflow",
        toolName: "write",
        refreshAuth,
      })
    ).rejects.toThrow("timeout")
    expect(refreshAuth).not.toHaveBeenCalled()
    expect(fixture.callTool).toHaveBeenCalledTimes(1)
  })

  it("does not repeat a cold connection attempt after an explicit 401", async () => {
    const open = jest.fn(async () => {
      throw Object.assign(new Error("HTTP 401"), { status: 401 })
    })
    const gateway = new McpRuntimeGateway({ open: open as never, retryDelayMs: 0 })
    await expect(
      gateway.invoke({ scopeId: "auth", server: server(), surface: "chat", toolName: "do" })
    ).rejects.toThrow("401")
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("reads resources and resolves prompt templates through the shared lease", async () => {
    const fixture = fixtureOpen()
    const gateway = new McpRuntimeGateway({ open: fixture.open })
    const input = { scopeId: "chat-1", server: server(), surface: "chat" as const }

    await expect(gateway.readResource({ ...input, uri: "issue://1" })).resolves.toEqual({
      contents: [{ uri: "issue://1", mimeType: "text/plain", text: "Issue 1" }],
    })
    await expect(
      gateway.getPrompt({ ...input, promptName: "review", arguments: { id: "1" } })
    ).resolves.toEqual({
      description: "Review",
      messages: [{ role: "user", content: { type: "text", text: "Review it" } }],
    })
    expect(fixture.open).toHaveBeenCalledTimes(1)
    expect(fixture.readResource).toHaveBeenCalledWith({ uri: "issue://1" })
    expect(fixture.getPrompt).toHaveBeenCalledWith({ name: "review", arguments: { id: "1" } })
  })

  it("aborts the upstream SDK request when the tool deadline expires", async () => {
    let upstreamSignal: AbortSignal | undefined
    const callTool = jest.fn(
      async (_params: unknown, _schema?: unknown, options?: { signal?: AbortSignal }) => {
        upstreamSignal = options?.signal
        await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("upstream aborted")), {
            once: true,
          })
        })
        return { content: [] }
      }
    )
    const open = jest.fn(async () => ({
      client: {
        callTool,
        listTools: async () => ({ tools: [] }),
        listResources: async () => ({ resources: [] }),
        listPrompts: async () => ({ prompts: [] }),
      },
      transport: {},
      close: async () => undefined,
    }))
    const gateway = new McpRuntimeGateway({ open: open as never, toolTimeoutMs: 5 })

    await expect(
      gateway.invoke({
        scopeId: "deadline",
        server: server(),
        surface: "workflow",
        toolName: "slow",
      })
    ).rejects.toThrow("timed out")
    expect(upstreamSignal?.aborted).toBe(true)
  })

  it("invalidates cached capabilities when the server reports a tool-list change", async () => {
    const fixture = fixtureOpen()
    const gateway = new McpRuntimeGateway({ open: fixture.open })
    const invalidate = jest.spyOn(gateway, "invalidateCapabilities").mockResolvedValue(undefined)

    await gateway.invoke({
      scopeId: "run",
      server: server(),
      surface: "workflow",
      toolName: "do",
    })
    const options = (fixture.open as jest.Mock).mock.calls[0][1] as {
      onToolsChanged: () => Promise<void>
    }
    await options.onToolsChanged()

    expect(invalidate).toHaveBeenCalledWith("mcp-a")
  })

  it("audits connect, discovery, and calls without durable payloads", async () => {
    const fixture = fixtureOpen()
    const gateway = new McpRuntimeGateway({ open: fixture.open })
    const input = { scopeId: "audit", server: server(), surface: "workflow" as const }

    await gateway.discover(input)
    await gateway.invoke({ ...input, toolName: "do", args: { secret: "never-audited" } })

    expect(mockAppendMcpAuditLog.mock.calls.map(([row]) => row.phase)).toEqual([
      "connect",
      "discover",
      "call",
    ])
    for (const [row] of mockAppendMcpAuditLog.mock.calls) {
      expect(row).not.toHaveProperty("args")
      expect(row).not.toHaveProperty("result")
      expect(row).not.toHaveProperty("headers")
    }
    await gateway.closeScope("audit")
  })

  it("treats unsupported optional resource and prompt capabilities as empty", async () => {
    const close = jest.fn(async () => undefined)
    const open = jest.fn(async () => ({
      client: {
        callTool: async () => ({ content: [] }),
        listTools: async () => ({ tools: [{ name: "do" }] }),
        listResources: async () => {
          throw new Error("-32601 Method not found")
        },
        listPrompts: async () => {
          throw new Error("unsupported capability")
        },
      },
      transport: {},
      close,
    }))
    const gateway = new McpRuntimeGateway({ open: open as never })

    await expect(
      gateway.discover({ scopeId: "optional", server: server("optional"), surface: "settings" })
    ).resolves.toEqual({
      tools: [{ name: "do" }],
      resources: [],
      prompts: [],
      cacheHit: false,
    })
    await gateway.closeScope("optional")
  })

  it("opens the circuit after three exhausted connection failures", async () => {
    const open = jest.fn(async () => {
      throw new Error("offline")
    })
    const gateway = new McpRuntimeGateway({ open: open as never, retryDelayMs: 0 })
    const input = { scopeId: "run", server: server(), surface: "workflow" as const, toolName: "do" }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(gateway.invoke(input)).rejects.toThrow("offline")
    }
    await expect(gateway.invoke(input)).rejects.toThrow("circuit open")
    expect(open).toHaveBeenCalledTimes(6)
  })

  describe("per-operation policy", () => {
    it("never sends exact, glob or portable-policy denied tools to the transport", async () => {
      const fixture = fixtureOpen()
      const gateway = new McpRuntimeGateway({ open: fixture.open, retryDelayMs: 0 })
      const restricted = {
        ...server("rules"),
        disallowedTools: ["delete"],
        disallowedToolPatterns: ["write_*"],
        toolPermissionRules: [{ name: "drop_table", decision: "deny" as const }],
      }
      const input = { scopeId: "rules", server: restricted, surface: "workflow" as const }
      for (const toolName of ["delete", "write_file", "WRITE_ALL", "drop_table"]) {
        await expect(gateway.invoke({ ...input, toolName })).rejects.toThrow(
          /MCP execution deny: tool .* is denied/
        )
      }
      expect(fixture.callTool).not.toHaveBeenCalled()
      await gateway.invoke({ ...input, toolName: "read_file" })
      expect(fixture.callTool).toHaveBeenCalledTimes(1)
      expect(mockAppendMcpAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "delete", decision: "deny", errorCode: "blocked" })
      )
      await gateway.closeScope("rules")
    })

    it("refuses an ask-policy tool headlessly but lets an interactive caller run it", async () => {
      const fixture = fixtureOpen()
      const gateway = new McpRuntimeGateway({ open: fixture.open, retryDelayMs: 0 })
      const asking = {
        ...server("ask"),
        toolPermissionRules: [{ name: "send", decision: "ask" as const }],
      }
      await expect(
        gateway.invoke({ scopeId: "ask", server: asking, surface: "workflow", toolName: "send" })
      ).rejects.toThrow(/requires approval/)
      expect(fixture.callTool).not.toHaveBeenCalled()
      await gateway.invoke({
        scopeId: "ask",
        server: asking,
        surface: "chat",
        interactive: true,
        toolName: "send",
      })
      expect(fixture.callTool).toHaveBeenCalledTimes(1)
      await gateway.closeScope("ask")
    })

    it.each([
      ["disabled", { enabled: false }],
      ["blocked", { trust: { state: "blocked" as const } }],
    ])("does not reuse a warm lease after the server is %s", async (_label, change) => {
      const fixture = fixtureOpen()
      const gateway = new McpRuntimeGateway({ open: fixture.open, retryDelayMs: 0 })
      const original = server("revoked")
      await gateway.invoke({
        scopeId: "a",
        server: original,
        surface: "workflow",
        toolName: "do",
      })
      await gateway.invoke({
        scopeId: "b",
        server: original,
        surface: "workflow",
        toolName: "do",
      })
      expect(fixture.open).toHaveBeenCalledTimes(2)

      const revoked = { ...original, ...change } as McpServer
      for (const operation of [
        () =>
          gateway.invoke({ scopeId: "a", server: revoked, surface: "workflow", toolName: "do" }),
        () =>
          gateway.readResource({ scopeId: "a", server: revoked, surface: "chat", uri: "x://1" }),
        () =>
          gateway.getPrompt({ scopeId: "a", server: revoked, surface: "chat", promptName: "p" }),
      ]) {
        await expect(operation()).rejects.toThrow(/MCP execution deny/)
      }
      expect(fixture.callTool).toHaveBeenCalledTimes(2)
      expect(fixture.readResource).not.toHaveBeenCalled()
      expect(fixture.getPrompt).not.toHaveBeenCalled()
      // Revocation tears down the server's warm connections in every scope.
      expect(fixture.close).toHaveBeenCalledTimes(2)
      expect(fixture.open).toHaveBeenCalledTimes(2)
    })

    it("re-checks a narrower or expired grant against the warm lease of a pending server", async () => {
      const fixture = fixtureOpen()
      let now = 1_000
      const gateway = new McpRuntimeGateway({ open: fixture.open, retryDelayMs: 0, now: () => now })
      const pending = { ...server("pending"), trust: { state: "pending" as const } }
      const { fingerprintMcpDefinition } = await import("./server-definition")
      const grant = {
        serverId: pending.id,
        fingerprint: fingerprintMcpDefinition(pending),
        tools: ["search"],
        expiresAt: 2_000,
      }
      const input = { scopeId: "plan", server: pending, surface: "plan" as const, grant }
      await gateway.invoke({ ...input, toolName: "search" })
      await expect(gateway.invoke({ ...input, toolName: "delete" })).rejects.toThrow(
        /pending MCP server cannot execute/
      )
      now = 3_000
      await expect(gateway.invoke({ ...input, toolName: "search" })).rejects.toThrow(
        /pending MCP server cannot execute/
      )
      expect(fixture.callTool).toHaveBeenCalledTimes(1)
      expect(fixture.callTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "search" }),
        undefined,
        expect.anything()
      )
      await gateway.closeScope("plan")
    })

    it("re-checks policy on the refreshed definition before an auth retry", async () => {
      const fixture = fixtureOpen()
      fixture.callTool.mockRejectedValueOnce(Object.assign(new Error("401"), { status: 401 }))
      const gateway = new McpRuntimeGateway({ open: fixture.open, retryDelayMs: 0 })
      const original = server("refresh")
      await expect(
        gateway.invoke({
          scopeId: "r",
          server: original,
          surface: "workflow",
          toolName: "do",
          // Disabled while the token endpoint was being called.
          refreshAuth: async () => ({ server: { ...original, enabled: false } }),
        })
      ).rejects.toThrow(/server is disabled/)
      expect(fixture.callTool).toHaveBeenCalledTimes(1)
      expect(fixture.open).toHaveBeenCalledTimes(1)
    })

    it("refuses discovery of a blocked server even with a cached capability row", async () => {
      const fixture = fixtureOpen()
      const gateway = new McpRuntimeGateway({ open: fixture.open, retryDelayMs: 0 })
      const trusted = server("cached")
      await gateway.discover({ scopeId: "d", server: trusted, surface: "settings" })
      await expect(
        gateway.discover({
          scopeId: "d",
          server: { ...trusted, trust: { state: "blocked" } },
          surface: "settings",
        })
      ).rejects.toThrow(/trust is blocked/)
    })
  })
})
