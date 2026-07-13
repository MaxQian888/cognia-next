/**
 * @jest-environment jsdom
 *
 * Focused test for the `action.mcp.invokeTool` executor's plugin-event
 * dispatch wiring (Tier 2 of ADR 0016). The MCP SDK is mocked at the
 * module level so we never spin up a real server, then we drive the
 * executor and assert the four `dispatchMCP*` calls fire in order.
 *
 * Lives in its own file (rather than in `built-ins.test.ts`) because the
 * SDK mocks must be declared *before* `built-ins.ts` is imported — the
 * shared file can't accommodate that without breaking the existing
 * action.mcp tests.
 */

import "fake-indexeddb/auto"

const callTool = jest.fn(async () => ({
  isError: false,
  content: [{ type: "text", text: "ok" }],
}))
const close = jest.fn(async () => undefined)
const connect = jest.fn(async () => undefined)

jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn().mockImplementation(() => ({ connect, callTool, close })),
}))
jest.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({})),
}))
const StreamableHTTPClientTransport = jest.fn().mockImplementation(() => ({ __kind: "http" }))
const SSEClientTransport = jest.fn().mockImplementation(() => ({ __kind: "sse" }))
jest.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport,
}))
jest.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport,
}))

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import "./built-ins"
import { getExecutor } from "./registry"
import { getPluginEventHooks } from "@/lib/plugin"
import type { McpServer } from "@cognia/agent-config-types"
import type { StepExecutionContext, TriggerEvent, WorkflowNodeKind } from "@/types/workflow/visual"

const trigger: TriggerEvent = {
  workflowId: "wf",
  kind: "trigger.manual",
  payload: {},
  originAt: 1,
}

function makeCtx<T extends Record<string, unknown>>(
  kind: WorkflowNodeKind,
  params: T
): StepExecutionContext<T> {
  return {
    runId: "run_test",
    workflowId: "wf",
    stepId: "n_test",
    params,
    upstream: {},
    trigger,
    signal: new AbortController().signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  } as StepExecutionContext<T>
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  callTool.mockClear()
  close.mockClear()
  connect.mockClear()
  StreamableHTTPClientTransport.mockClear()
  SSEClientTransport.mockClear()
})

describe("action.mcp.invokeTool — plugin event dispatch", () => {
  it("fires connect / toolCall / toolResult / disconnect through getPluginEventHooks", async () => {
    const server: McpServer = {
      id: "mcp_dispatch_test",
      name: "Dispatch Test",
      transport: "stdio",
      config: { command: "echo", args: ["hello"] },
      enabled: true,
      appsEnabled: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await getDb().mcpServers.put(server)

    const hooks = getPluginEventHooks()
    const connectSpy = jest.spyOn(hooks, "dispatchMCPServerConnect").mockImplementation(() => {})
    const toolCallSpy = jest.spyOn(hooks, "dispatchMCPToolCall").mockImplementation(() => {})
    const toolResultSpy = jest.spyOn(hooks, "dispatchMCPToolResult").mockImplementation(() => {})
    const disconnectSpy = jest
      .spyOn(hooks, "dispatchMCPServerDisconnect")
      .mockImplementation(() => {})

    const reg = getExecutor("action.mcp.invokeTool", 1)
    if (!reg) throw new Error("action.mcp.invokeTool not registered")

    await reg.execute(
      makeCtx("action.mcp.invokeTool", {
        serverId: "mcp_dispatch_test",
        toolName: "echo",
        args: { foo: 1 },
      })
    )
    expect(connectSpy).toHaveBeenCalledWith("mcp_dispatch_test", "Dispatch Test")
    expect(toolCallSpy).toHaveBeenCalledWith("mcp_dispatch_test", "echo", { foo: 1 })
    expect(toolResultSpy).toHaveBeenCalledWith(
      "mcp_dispatch_test",
      "echo",
      expect.objectContaining({ isError: false })
    )
    expect(disconnectSpy).toHaveBeenCalledWith("mcp_dispatch_test")
  })

  it("connects an sse server via the SSE transport and forwards headers (regression)", async () => {
    // Regression for the prior bug: the node hard-coded StreamableHTTPClientTransport
    // for every non-stdio server, so `transport: "sse"` servers connected to the
    // wrong transport and `config.headers` was dropped.
    const server: McpServer = {
      id: "mcp_sse_test",
      name: "SSE Test",
      transport: "sse",
      config: { url: "https://example.test/sse", headers: { Authorization: "Bearer t" } },
      enabled: true,
      appsEnabled: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await getDb().mcpServers.put(server)

    const reg = getExecutor("action.mcp.invokeTool", 1)
    if (!reg) throw new Error("action.mcp.invokeTool not registered")
    await reg.execute(
      makeCtx("action.mcp.invokeTool", { serverId: "mcp_sse_test", toolName: "echo", args: {} })
    )

    // SSE transport chosen, not the streamable-HTTP one.
    expect(SSEClientTransport).toHaveBeenCalledTimes(1)
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled()
    // URL + headers folded into requestInit.
    const [url, opts] = SSEClientTransport.mock.calls[0]
    expect((url as URL).href).toBe("https://example.test/sse")
    expect(opts).toEqual({ requestInit: { headers: { Authorization: "Bearer t" } } })
  })
})
