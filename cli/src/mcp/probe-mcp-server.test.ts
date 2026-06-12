/**
 * @jest-environment node
 */
import type { McpServer } from "@/lib/claude/types"

import type { OpenedMcp } from "./mcp-client"
import { isUnauthorized, probeMcpServer } from "./probe-mcp-server"

const srv = (over: Partial<McpServer> = {}): McpServer =>
  ({
    id: "mcp_s",
    name: "s",
    transport: "http",
    config: { url: "https://x" },
    enabled: true,
    ...over,
  }) as McpServer

function fakeOpen(
  client: Partial<OpenedMcp["client"]>,
  onOpen?: () => void
): (s: McpServer, o: { signal?: AbortSignal }) => Promise<OpenedMcp> {
  return async () => {
    onOpen?.()
    return {
      client: {
        connect: async () => undefined,
        listTools: async () => ({ tools: [] }),
        listResources: async () => ({ resources: [] }),
        listPrompts: async () => ({ prompts: [] }),
        close: async () => undefined,
        ...client,
      } as OpenedMcp["client"],
      transport: {},
      close: async () => undefined,
    }
  }
}

describe("isUnauthorized", () => {
  it.each([
    [{ name: "UnauthorizedError" }, true],
    [{ message: "HTTP 401" }, true],
    [{ message: "invalid_token" }, true],
    [{ message: "ECONNREFUSED" }, false],
    [null, false],
  ])("classifies %p as %p", (err, expected) => {
    expect(isUnauthorized(err)).toBe(expected)
  })
})

describe("probeMcpServer", () => {
  it("reports disabled without connecting", async () => {
    let opened = false
    const res = await probeMcpServer(srv({ enabled: false }), {
      open: fakeOpen({}, () => {
        opened = true
      }),
    })
    expect(res.status).toBe("disabled")
    expect(opened).toBe(false)
  })

  it("collects tools, resources, and prompts on a healthy server", async () => {
    const res = await probeMcpServer(srv(), {
      open: fakeOpen({
        listTools: async () => ({
          tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
        }),
        listResources: async () => ({ resources: [{ uri: "file://a", name: "A" }] }),
        listPrompts: async () => ({ prompts: [{ name: "p", description: "pd" }] }),
      }),
    })
    expect(res.status).toBe("connected")
    expect(res.tools).toEqual([{ name: "t", description: "d", inputSchema: { type: "object" } }])
    expect(res.resources).toEqual([
      { uri: "file://a", name: "A", description: undefined, mimeType: undefined },
    ])
    expect(res.prompts).toEqual([{ name: "p", description: "pd", arguments: undefined }])
  })

  it("treats a server without resources/prompts capability as empty (fail-soft)", async () => {
    const res = await probeMcpServer(srv(), {
      open: fakeOpen({
        listTools: async () => ({ tools: [{ name: "t" }] }),
        listResources: async () => {
          throw new Error("Method not found")
        },
        listPrompts: async () => {
          throw new Error("Method not found")
        },
      }),
    })
    expect(res.status).toBe("connected")
    expect(res.resources).toEqual([])
    expect(res.prompts).toEqual([])
  })

  it("reports needs_auth when the connection fails with a 401", async () => {
    const res = await probeMcpServer(srv(), {
      open: async () => {
        const e = new Error("HTTP 401 Unauthorized")
        e.name = "UnauthorizedError"
        throw e
      },
    })
    expect(res.status).toBe("needs_auth")
    expect(res.error).toMatch(/401/)
  })

  it("reports failed on a generic connection error", async () => {
    const res = await probeMcpServer(srv(), {
      open: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(res.status).toBe("failed")
    expect(res.error).toBe("ECONNREFUSED")
  })

  it("times out a hung connection as failed and aborts", async () => {
    let aborted = false
    const res = await probeMcpServer(srv(), {
      timeoutMs: 10,
      open: (_s, o) =>
        new Promise((_resolve, reject) => {
          o.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        }),
    })
    expect(res.status).toBe("failed")
    expect(res.error).toMatch(/timed out after 10ms/)
    expect(aborted).toBe(true)
  })

  it("skips resource/prompt listing when asked (status-only)", async () => {
    const listResources = jest.fn(async () => ({ resources: [] }))
    const listPrompts = jest.fn(async () => ({ prompts: [] }))
    const res = await probeMcpServer(srv(), {
      skipResources: true,
      skipPrompts: true,
      open: fakeOpen({ listResources, listPrompts }),
    })
    expect(res.status).toBe("connected")
    expect(listResources).not.toHaveBeenCalled()
    expect(listPrompts).not.toHaveBeenCalled()
  })

  it("invokes the authProvider factory for remote servers", async () => {
    const authProvider = jest.fn(() => ({ tag: "p" }))
    let seenAuth: unknown
    await probeMcpServer(srv(), {
      authProvider,
      open: async (_s, o) => {
        seenAuth = (o as { authProvider?: unknown }).authProvider
        return {
          client: {
            connect: async () => undefined,
            listTools: async () => ({ tools: [] }),
            listResources: async () => ({ resources: [] }),
            listPrompts: async () => ({ prompts: [] }),
            close: async () => undefined,
          } as OpenedMcp["client"],
          transport: {},
          close: async () => undefined,
        }
      },
    })
    expect(authProvider).toHaveBeenCalled()
    expect(seenAuth).toEqual({ tag: "p" })
  })
})
