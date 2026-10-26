import type { McpServer } from "@cognia/agent-config-types"

import { CogniaAcpDynamicMcpController } from "./acp-dynamic-mcp-controller"

const server = {
  id: "server-1",
  name: "server",
  enabled: true,
  transport: "stdio",
  config: { command: "mcp-server" },
  trust: { state: "trusted" },
} as McpServer

describe("CogniaAcpDynamicMcpController", () => {
  it("bridges requests, notifications, and server notifications with session ownership", async () => {
    const request = jest.fn(async () => ({ tools: [] }))
    const notification = jest.fn(async () => undefined)
    const close = jest.fn(async () => undefined)
    const client = { request, notification } as never
    const controller = new CogniaAcpDynamicMcpController({
      getServer: async () => server,
      open: async () => ({ client, transport: {}, close }),
      createConnectionId: () => "connection-1",
    })
    const notify = jest.fn()
    await expect(
      controller.connect(
        { serverId: "server-1" },
        { sessionId: "session-1", signal: new AbortController().signal, notify }
      )
    ).resolves.toEqual({ connectionId: "connection-1" })

    await expect(
      controller.message(
        { connectionId: "connection-1", method: "tools/list" },
        { sessionId: "session-1", notification: false }
      )
    ).resolves.toEqual({ tools: [] })
    await controller.message(
      { connectionId: "connection-1", method: "notifications/initialized" },
      { sessionId: "session-1", notification: true }
    )
    expect(notification).toHaveBeenCalledWith(
      { method: "notifications/initialized" },
      { signal: undefined }
    )

    await (
      client as { fallbackNotificationHandler: (value: unknown) => Promise<void> }
    ).fallbackNotificationHandler({ method: "notifications/tools/list_changed" })
    expect(notify).toHaveBeenCalledWith({
      connectionId: "connection-1",
      method: "notifications/tools/list_changed",
    })

    await expect(
      controller.message(
        { connectionId: "connection-1", method: "tools/list" },
        { sessionId: "other-session", notification: false }
      )
    ).rejects.toThrow("Unknown MCP-over-ACP connection")
    await controller.disconnect({ connectionId: "connection-1" }, { sessionId: "session-1" })
    expect(close).toHaveBeenCalled()
  })

  it("rejects disabled or missing registered servers", async () => {
    const controller = new CogniaAcpDynamicMcpController({
      getServer: async () => undefined,
    })
    await expect(
      controller.connect(
        { serverId: "missing" },
        { sessionId: "session-1", signal: new AbortController().signal, notify: jest.fn() }
      )
    ).rejects.toThrow("was not found")
  })

  describe("after connect", () => {
    async function connected(current: () => McpServer | undefined) {
      const request = jest.fn(async () => ({ ok: true }))
      const close = jest.fn(async () => undefined)
      const controller = new CogniaAcpDynamicMcpController({
        getServer: async () => current(),
        open: async () => ({ client: { request } as never, transport: {}, close }),
        createConnectionId: () => "connection-1",
      })
      await controller.connect(
        { serverId: "server-1" },
        { sessionId: "session-1", signal: new AbortController().signal, notify: jest.fn() }
      )
      const send = (method: string, params?: Record<string, unknown>) =>
        controller.message(
          { connectionId: "connection-1", method, ...(params ? { params } : {}) },
          { sessionId: "session-1", notification: false }
        )
      return { request, close, send }
    }

    it.each([
      ["disabled", { ...server, enabled: false }],
      ["blocked", { ...server, trust: { state: "blocked" as const } }],
      ["deleted", undefined],
    ])("ends the connection once the server is %s", async (_label, revoked) => {
      let current: McpServer | undefined = server
      const { request, close, send } = await connected(() => current)
      await send("tools/list")
      current = revoked as McpServer | undefined
      await expect(send("tools/list")).rejects.toThrow()
      expect(request).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledTimes(1)
      await expect(send("tools/list")).rejects.toThrow("Unknown MCP-over-ACP connection")
    })

    it("refuses the open client once the definition is edited, even if re-trusted", async () => {
      let current: McpServer = server
      const { request, close, send } = await connected(() => current)
      current = {
        ...server,
        revision: 2,
        config: { command: "new-server" },
        trust: { state: "trusted" },
      } as McpServer
      await expect(send("tools/call", { name: "read_file", arguments: {} })).rejects.toThrow(
        /changed since this connection opened/
      )
      expect(request).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
    })

    it("refuses a tools/call for a tool a saved rule denies, keeping the connection", async () => {
      const restricted = { ...server, disallowedToolPatterns: ["write_*"] }
      const { request, close, send } = await connected(() => restricted)
      await expect(send("tools/call", { name: "write_file", arguments: {} })).rejects.toThrow(
        /denied by a saved rule/
      )
      await send("tools/call", { name: "read_file", arguments: {} })
      expect(request).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()
    })
  })
})
