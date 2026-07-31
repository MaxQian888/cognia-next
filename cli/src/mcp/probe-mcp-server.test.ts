/**
 * @jest-environment node
 */
import type { McpServer } from "@cognia/agent-config-types"

import type { OpenedMcp } from "./mcp-client"
import { isUnauthorized, makeStderrTail, probeMcpServer } from "./probe-mcp-server"

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

describe("makeStderrTail", () => {
  it("returns the last non-blank lines, trailing-trimmed", () => {
    const t = makeStderrTail()
    t.push("first\n\n  second  \n")
    t.push("third\n")
    expect(t.value()).toBe("first\n  second\nthird")
  })

  it("is empty when nothing was captured", () => {
    expect(makeStderrTail().value()).toBe("")
  })

  it("keeps only the tail once past the byte cap", () => {
    const t = makeStderrTail()
    t.push("x".repeat(3000) + "\nTAIL_LINE\n")
    const value = t.value()
    expect(value.endsWith("TAIL_LINE")).toBe(true)
    expect(value.length).toBeLessThanOrEqual(2000)
  })

  it("keeps only the last N lines", () => {
    const t = makeStderrTail()
    for (let i = 0; i < 20; i++) t.push(`line${i}\n`)
    const lines = t.value().split("\n")
    expect(lines).toHaveLength(8)
    expect(lines[lines.length - 1]).toBe("line19")
    expect(lines[0]).toBe("line12")
  })
})

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

  it("appends the captured stderr tail to a failed probe's error", async () => {
    const res = await probeMcpServer(srv(), {
      attempts: 1,
      open: async (_s, o) => {
        o.onStderr?.("Traceback (most recent call last):\n")
        o.onStderr?.("ModuleNotFoundError: No module named 'foo'\n")
        throw new Error("connection closed")
      },
    })
    expect(res.status).toBe("failed")
    expect(res.error).toContain("connection closed")
    expect(res.error).toContain("ModuleNotFoundError: No module named 'foo'")
  })

  it("leaves the error unchanged when no stderr was captured", async () => {
    const res = await probeMcpServer(srv(), {
      attempts: 1,
      open: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(res.error).toBe("ECONNREFUSED")
  })

  it("reports failed on a generic connection error (after exhausting retries)", async () => {
    let calls = 0
    const res = await probeMcpServer(srv(), {
      retryDelayMs: 0,
      open: async () => {
        calls++
        throw new Error("ECONNREFUSED")
      },
    })
    expect(res.status).toBe("failed")
    expect(res.error).toBe("ECONNREFUSED")
    expect(calls).toBe(2) // default: one automatic retry before giving up
  })

  it("stringifies a non-Error rejection in the reported failure", async () => {
    const res = await probeMcpServer(srv(), {
      attempts: 1,
      open: async () => {
        // A non-Error rejection exercises the `String(err)` coercion path.
        return Promise.reject("kaput")
      },
    })
    expect(res.status).toBe("failed")
    expect(res.error).toBe("kaput")
  })

  it("tolerates a server that returns undefined tool/resource/prompt lists", async () => {
    const res = await probeMcpServer(srv(), {
      open: fakeOpen({
        listTools: async () => ({}) as { tools?: never },
        listResources: async () => ({}) as { resources?: never },
        listPrompts: async () => ({}) as { prompts?: never },
      }),
    })
    expect(res.status).toBe("connected")
    expect(res).toMatchObject({ tools: [], resources: [], prompts: [] })
  })

  it("waits retryDelayMs before retrying a cold-start failure", async () => {
    let calls = 0
    const res = await probeMcpServer(srv(), {
      retryDelayMs: 1,
      open: async (s, o) => {
        calls++
        if (calls === 1) throw new Error("cold start")
        return fakeOpen({})(s, o)
      },
    })
    expect(res.status).toBe("connected")
    expect(calls).toBe(2)
  })

  it("recovers a server that fails its first connect (retry → connected)", async () => {
    let calls = 0
    const res = await probeMcpServer(srv(), {
      retryDelayMs: 0,
      open: async (s, o) => {
        calls++
        if (calls === 1) throw new Error("cold start")
        return fakeOpen({})(s, o)
      },
    })
    expect(res.status).toBe("connected")
    expect(calls).toBe(2)
  })

  it("does not retry an auth failure", async () => {
    let calls = 0
    const res = await probeMcpServer(srv(), {
      retryDelayMs: 0,
      open: async () => {
        calls++
        const e = new Error("HTTP 401 Unauthorized")
        e.name = "UnauthorizedError"
        throw e
      },
    })
    expect(res.status).toBe("needs_auth")
    expect(calls).toBe(1)
  })

  it("honours attempts: 1 (no retry)", async () => {
    let calls = 0
    const res = await probeMcpServer(srv(), {
      attempts: 1,
      retryDelayMs: 0,
      open: async () => {
        calls++
        throw new Error("down")
      },
    })
    expect(res.status).toBe("failed")
    expect(calls).toBe(1)
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
            callTool: async () => ({ content: [] }),
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
