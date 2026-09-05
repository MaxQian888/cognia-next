/**
 * @jest-environment node
 */
import type { McpServer } from "@cognia/agent-config-types"

import { probeMcpTools } from "./probe-mcp-tools"
import { openMcpClient } from "./mcp-client"
jest.mock("./mcp-client", () => ({ openMcpClient: jest.fn() }))

const stdio = (config: Record<string, unknown> = { command: "x" }): McpServer =>
  ({ id: "mcp_s", name: "s", transport: "stdio", config, enabled: true }) as McpServer

describe("probeMcpTools", () => {
  it("passes stored OAuth credentials to the live client and closes it", async () => {
    const authProvider = { tokens: jest.fn() }
    const close = jest.fn(async () => undefined)
    jest.mocked(openMcpClient).mockResolvedValueOnce({
      client: { listTools: async () => ({ tools: [{ name: "private-tool" }] }) },
      close,
      transport: {},
    } as never)
    expect(await probeMcpTools(stdio(), { authProvider })).toEqual([{ name: "private-tool" }])
    expect(openMcpClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authProvider })
    )
    expect(close).toHaveBeenCalledTimes(1)
  })
  it("does not connect when already canceled", async () => {
    const controller = new AbortController()
    controller.abort()
    const connect = jest.fn(async () => [])
    await expect(
      probeMcpTools(stdio(), { signal: controller.signal, connect })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(connect).not.toHaveBeenCalled()
  })

  it("cancels a connector that ignores cancellation without waiting for timeout", async () => {
    const controller = new AbortController()
    let childSignal!: AbortSignal
    const pending = probeMcpTools(stdio(), {
      signal: controller.signal,
      connect: async (_s, signal) => {
        childSignal = signal
        return new Promise(() => {})
      },
    })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await rejected
    expect(childSignal.aborted).toBe(true)
  })
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
