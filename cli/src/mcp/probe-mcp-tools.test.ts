/**
 * @jest-environment node
 */
import type { McpServer } from "@cognia/agent-config-types"

import { probeMcpTools } from "./probe-mcp-tools"

const stdio = (config: Record<string, unknown> = { command: "x" }): McpServer =>
  ({ id: "mcp_s", name: "s", transport: "stdio", config, enabled: true }) as McpServer

describe("probeMcpTools", () => {
  it("returns the tools from the injected connection", async () => {
    const tools = await probeMcpTools(stdio(), {
      connect: async () => [{ name: "a", description: "first" }, { name: "b" }],
    })
    expect(tools).toEqual([{ name: "a", description: "first" }, { name: "b" }])
  })

  it("passes the server through to the connector", async () => {
    let seen: McpServer | null = null
    await probeMcpTools(stdio({ command: "echo" }), {
      connect: async (server) => {
        seen = server
        return []
      },
    })
    expect(seen).not.toBeNull()
    expect(seen!.config.command).toBe("echo")
  })

  it("rejects with a timeout error and aborts the signal when the probe hangs", async () => {
    let aborted = false
    const probe = probeMcpTools(stdio(), {
      timeoutMs: 10,
      connect: (_server, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        }),
    })
    await expect(probe).rejects.toThrow(/timed out after 10ms/)
    expect(aborted).toBe(true)
  })

  it("propagates a connection failure", async () => {
    await expect(
      probeMcpTools(stdio(), {
        connect: async () => {
          throw new Error("ECONNREFUSED")
        },
      })
    ).rejects.toThrow("ECONNREFUSED")
  })
})
