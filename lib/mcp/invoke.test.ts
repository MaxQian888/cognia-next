/**
 * @jest-environment node
 */
import type { McpServer } from "@/lib/claude/types"

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

  it("falls back to a preset when no stored row exists", async () => {
    const { open, openSpy } = fakeOpen()
    await invokeMcpTool(
      { serverId: "playwright", toolName: "screenshot" },
      {
        getServer: async () => undefined,
        getPreset: () => ({ name: "Playwright", transport: "stdio", config: { command: "npx" } }),
        open,
      }
    )
    const passedServer = openSpy.mock.calls[0][0] as McpServer
    expect(passedServer.name).toBe("Playwright")
    expect(passedServer.transport).toBe("stdio")
    expect(passedServer.config).toEqual({ command: "npx" })
  })

  it("throws McpServerNotFoundError when neither row nor preset matches", async () => {
    const { open } = fakeOpen()
    await expect(
      invokeMcpTool(
        { serverId: "missing", toolName: "x" },
        { getServer: async () => undefined, getPreset: () => undefined, open }
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

  it("validates serverId and toolName", async () => {
    await expect(invokeMcpTool({ serverId: "  ", toolName: "x" })).rejects.toThrow("serverId")
    await expect(invokeMcpTool({ serverId: "s", toolName: " " })).rejects.toThrow("toolName")
  })
})
