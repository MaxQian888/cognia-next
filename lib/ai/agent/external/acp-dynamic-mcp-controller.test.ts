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
})
