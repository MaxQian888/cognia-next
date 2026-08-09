/**
 * @jest-environment node
 */
import type { McpServer } from "@cognia/agent-config-types"

import { invokeMcpTool, McpServerNotFoundError, type InvokeMcpToolDeps } from "./invoke"

const srv = (transport: McpServer["transport"], config: Record<string, unknown>): McpServer =>
  ({ id: "mcp_s", name: "s", transport, config, enabled: true }) as McpServer

function fakeOpen() {
  const callTool = jest.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
    isError: false,
  }))
  const close = jest.fn(async () => undefined)
  const open = jest.fn(async (server: McpServer, opts: Record<string, unknown>) => {
    void server
    void opts
    return { client: { callTool } as never, transport: {}, close }
  })
  return { open: open as unknown as InvokeMcpToolDeps["open"], callTool, close, openSpy: open }
}

describe("invokeMcpTool", () => {
  it("resolves a stored server and calls the tool", async () => {
    const { open, callTool } = fakeOpen()
    const res = await invokeMcpTool(
      { serverId: "mcp_s", toolName: "do", args: { a: 1 } },
      { getServer: async () => srv("sse", { url: "https://x/sse" }), open }
    )
    expect(callTool).toHaveBeenCalledWith({ name: "do", arguments: { a: 1 } })
    expect(res).toMatchObject({ serverId: "mcp_s", toolName: "do", isError: false })
    expect(res.content).toEqual([{ type: "text", text: "ok" }])
  })

  it("forwards signal, authProvider and clientInfo to the transport", async () => {
    const { open, openSpy } = fakeOpen()
    const ac = new AbortController()
    const authProvider = { tag: "p" }
    await invokeMcpTool(
      {
        serverId: "mcp_s",
        toolName: "do",
        signal: ac.signal,
        authProvider,
        clientInfo: { name: "cognia-workflow", version: "1.0.0" },
      },
      { getServer: async () => srv("http", { url: "https://x", headers: { A: "1" } }), open }
    )
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy.mock.calls[0][1]).toMatchObject({
      signal: ac.signal,
      authProvider,
      clientInfo: { name: "cognia-workflow", version: "1.0.0" },
    })
  })

  it("does not execute plugin presets that lack a stored Registry row", async () => {
    const { open } = fakeOpen()
    await expect(
      invokeMcpTool(
        { serverId: "missing", toolName: "x" },
        { getServer: async () => undefined, open }
      )
    ).rejects.toBeInstanceOf(McpServerNotFoundError)
  })

  it("passes isError through and always closes the transport", async () => {
    const close = jest.fn(async () => undefined)
    const open = (async () => ({
      client: { callTool: async () => ({ content: [], isError: true }) } as never,
      transport: {},
      close,
    })) as unknown as InvokeMcpToolDeps["open"]
    const res = await invokeMcpTool(
      { serverId: "mcp_s", toolName: "do" },
      { getServer: async () => srv("stdio", { command: "x" }), open }
    )
    expect(res.isError).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("closes the transport even when the tool call throws", async () => {
    const close = jest.fn(async () => undefined)
    const open = (async () => ({
      client: {
        callTool: async () => {
          throw new Error("boom")
        },
      } as never,
      transport: {},
      close,
    })) as unknown as InvokeMcpToolDeps["open"]
    await expect(
      invokeMcpTool(
        { serverId: "mcp_s", toolName: "do" },
        { getServer: async () => srv("stdio", { command: "x" }), open }
      )
    ).rejects.toThrow("boom")
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("retries a failed first connect once and succeeds", async () => {
    const callTool = jest.fn(async () => ({ content: [], isError: false }))
    let calls = 0
    const open = (async () => {
      calls++
      if (calls === 1) throw new Error("cold start")
      return { client: { callTool } as never, transport: {}, close: async () => undefined }
    }) as unknown as InvokeMcpToolDeps["open"]
    const res = await invokeMcpTool(
      { serverId: "mcp_s", toolName: "do" },
      { getServer: async () => srv("http", { url: "https://x" }), open, retryDelayMs: 0 }
    )
    expect(calls).toBe(2)
    expect(res.isError).toBe(false)
  })

  it("surfaces the connect error after exhausting attempts", async () => {
    let calls = 0
    const open = (async () => {
      calls++
      throw new Error("ECONNREFUSED")
    }) as unknown as InvokeMcpToolDeps["open"]
    await expect(
      invokeMcpTool(
        { serverId: "mcp_s", toolName: "do" },
        { getServer: async () => srv("http", { url: "https://x" }), open, retryDelayMs: 0 }
      )
    ).rejects.toThrow("ECONNREFUSED")
    expect(calls).toBe(2)
  })

  it("does not retry the connect when the caller already aborted", async () => {
    const ac = new AbortController()
    let calls = 0
    const open = (async () => {
      calls++
      ac.abort()
      throw new Error("aborted")
    }) as unknown as InvokeMcpToolDeps["open"]
    await expect(
      invokeMcpTool(
        { serverId: "mcp_s", toolName: "do", signal: ac.signal },
        { getServer: async () => srv("http", { url: "https://x" }), open, retryDelayMs: 0 }
      )
    ).rejects.toThrow("aborted")
    expect(calls).toBe(1)
  })

  it("does not retry tool-call errors (tool may not be idempotent)", async () => {
    let opens = 0
    const callTool = jest.fn(async () => {
      throw new Error("tool boom")
    })
    const open = (async () => {
      opens++
      return { client: { callTool } as never, transport: {}, close: async () => undefined }
    }) as unknown as InvokeMcpToolDeps["open"]
    await expect(
      invokeMcpTool(
        { serverId: "mcp_s", toolName: "do" },
        { getServer: async () => srv("http", { url: "https://x" }), open, retryDelayMs: 0 }
      )
    ).rejects.toThrow("tool boom")
    expect(opens).toBe(1)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it("validates serverId and toolName", async () => {
    await expect(invokeMcpTool({ serverId: "  ", toolName: "x" })).rejects.toThrow("serverId")
    await expect(invokeMcpTool({ serverId: "s", toolName: " " })).rejects.toThrow("toolName")
  })
})
