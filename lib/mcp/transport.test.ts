/**
 * @jest-environment node
 */
import type { McpServer } from "@/lib/claude/types"

import {
  buildMcpTransport,
  createMcpConnection,
  openMcpClient,
  type McpTransportCtors,
} from "./transport"

const srv = (transport: McpServer["transport"], config: Record<string, unknown>): McpServer =>
  ({ id: "mcp_s", name: "s", transport, config, enabled: true }) as McpServer

function recordingCtors(): {
  ctors: McpTransportCtors
  calls: Array<{ kind: string; args: unknown[] }>
} {
  const calls: Array<{ kind: string; args: unknown[] }> = []
  const mk = (kind: string) =>
    class {
      constructor(...args: unknown[]) {
        calls.push({ kind, args })
      }
    }
  return {
    ctors: { Stdio: mk("stdio") as never, Http: mk("http") as never, Sse: mk("sse") as never },
    calls,
  }
}

describe("buildMcpTransport", () => {
  it("builds a stdio transport with command/args/env", () => {
    const { ctors, calls } = recordingCtors()
    buildMcpTransport(srv("stdio", { command: "npx", args: ["-y", "s"], env: { K: "v" } }), ctors)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe("stdio")
    expect(calls[0].args[0]).toEqual({ command: "npx", args: ["-y", "s"], env: { K: "v" } })
  })

  it("uses the streamable-HTTP ctor for http and folds headers into requestInit", () => {
    const { ctors, calls } = recordingCtors()
    buildMcpTransport(
      srv("http", { url: "https://x/mcp", headers: { Authorization: "Bearer t" } }),
      ctors
    )
    expect(calls[0].kind).toBe("http")
    expect((calls[0].args[0] as URL).href).toBe("https://x/mcp")
    expect(calls[0].args[1]).toEqual({ requestInit: { headers: { Authorization: "Bearer t" } } })
  })

  it("uses the SSE ctor for the sse transport (no opts when bare)", () => {
    const { ctors, calls } = recordingCtors()
    buildMcpTransport(srv("sse", { url: "https://x/sse" }), ctors)
    expect(calls[0].kind).toBe("sse")
    expect(calls[0].args[1]).toBeUndefined()
  })

  it("folds headers into the SSE transport too", () => {
    const { ctors, calls } = recordingCtors()
    buildMcpTransport(srv("sse", { url: "https://x/sse", headers: { A: "1" } }), ctors)
    expect(calls[0].kind).toBe("sse")
    expect(calls[0].args[1]).toEqual({ requestInit: { headers: { A: "1" } } })
  })

  it("attaches the authProvider when provided", () => {
    const { ctors, calls } = recordingCtors()
    const authProvider = { tag: "provider" }
    buildMcpTransport(srv("http", { url: "https://x" }), ctors, { authProvider })
    expect(calls[0].args[1]).toEqual({ authProvider })
  })
})

describe("createMcpConnection", () => {
  it("passes the provided clientInfo to the SDK Client", async () => {
    let seen: { name: string; version: string } | undefined
    const load = async () => ({
      Client: class {
        constructor(info: { name: string; version: string }) {
          seen = info
        }
      } as never,
      ctors: recordingCtors().ctors,
    })
    await createMcpConnection(
      srv("stdio", { command: "x" }),
      { clientInfo: { name: "cognia-workflow", version: "1.0.0" } },
      { load }
    )
    expect(seen).toEqual({ name: "cognia-workflow", version: "1.0.0" })
  })

  it("defaults the client identity when none is given", async () => {
    let seen: { name: string; version: string } | undefined
    const load = async () => ({
      Client: class {
        constructor(info: { name: string; version: string }) {
          seen = info
        }
      } as never,
      ctors: recordingCtors().ctors,
    })
    await createMcpConnection(srv("stdio", { command: "x" }), {}, { load })
    expect(seen?.name).toBe("cognia")
  })
})

describe("openMcpClient", () => {
  function fakeClient() {
    return {
      connect: jest.fn(async () => undefined),
      callTool: jest.fn(async () => ({ content: [] })),
      listTools: jest.fn(async () => ({ tools: [] })),
      listResources: jest.fn(async () => ({ resources: [] })),
      listPrompts: jest.fn(async () => ({ prompts: [] })),
      close: jest.fn(async () => undefined),
    }
  }
  const load = (client: ReturnType<typeof fakeClient>) => async () => ({
    Client: class {
      constructor() {
        return client as never
      }
    } as never,
    ctors: recordingCtors().ctors,
  })

  it("connects and returns a closable client", async () => {
    const client = fakeClient()
    const opened = await openMcpClient(srv("stdio", { command: "x" }), {}, { load: load(client) })
    expect(client.connect).toHaveBeenCalledTimes(1)
    await opened.close()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it("closes the client and rethrows when connect fails", async () => {
    const client = fakeClient()
    client.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    await expect(
      openMcpClient(srv("http", { url: "https://x" }), {}, { load: load(client) })
    ).rejects.toThrow("ECONNREFUSED")
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it("aborts the client when the signal fires", async () => {
    const client = fakeClient()
    const ac = new AbortController()
    await openMcpClient(
      srv("stdio", { command: "x" }),
      { signal: ac.signal },
      { load: load(client) }
    )
    ac.abort()
    expect(client.close).toHaveBeenCalled()
  })
})
