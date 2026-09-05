/**
 * @jest-environment node
 */
import type { McpServer } from "@cognia/agent-config-types"

import {
  buildMcpTransport,
  COGNIA_MCP_PROTOCOL_VERSIONS,
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
  it("builds a stdio transport with command/args/env and pipes stderr", () => {
    const { ctors, calls } = recordingCtors()
    buildMcpTransport(srv("stdio", { command: "npx", args: ["-y", "s"], env: { K: "v" } }), ctors)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe("stdio")
    // stderr MUST be "pipe": the SDK otherwise inherits it to our terminal and
    // smears the TUI frame (the whole point of this seam).
    expect(calls[0].args[0]).toEqual({
      command: "npx",
      args: ["-y", "s"],
      env: { K: "v" },
      stderr: "pipe",
    })
  })

  it("uses the streamable-HTTP ctor for http and folds headers into requestInit", () => {
    const { ctors, calls } = recordingCtors()
    buildMcpTransport(
      srv("http", { url: "https://x/mcp", headers: { Authorization: "Bearer t" } }),
      ctors
    )
    expect(calls[0].kind).toBe("http")
    expect((calls[0].args[0] as URL).href).toBe("https://x/mcp")
    expect(calls[0].args[1]).toEqual({
      requestInit: { headers: { Authorization: "Bearer t" }, redirect: "error" },
    })
  })

  it("uses the SSE ctor for the sse transport (no opts when bare)", () => {
    const { ctors, calls } = recordingCtors()
    buildMcpTransport(srv("sse", { url: "https://x/sse" }), ctors)
    expect(calls[0].kind).toBe("sse")
    expect(calls[0].args[1]).toEqual({ requestInit: { redirect: "error" } })
  })

  it("folds headers into the SSE transport too", () => {
    const { ctors, calls } = recordingCtors()
    buildMcpTransport(srv("sse", { url: "https://x/sse", headers: { A: "1" } }), ctors)
    expect(calls[0].kind).toBe("sse")
    expect(calls[0].args[1]).toEqual({
      requestInit: { headers: { A: "1" }, redirect: "error" },
    })
  })

  it("attaches the authProvider when provided", () => {
    const { ctors, calls } = recordingCtors()
    const authProvider = { tag: "provider" }
    buildMcpTransport(srv("http", { url: "https://x" }), ctors, { authProvider })
    expect(calls[0].args[1]).toEqual({
      authProvider,
      requestInit: { redirect: "error" },
    })
  })

  it("uses the guarded fetch for every remote HTTP and SSE socket", () => {
    const guardedFetch = jest.fn()
    for (const transport of ["http", "sse"] as const) {
      const { ctors, calls } = recordingCtors()
      buildMcpTransport(srv(transport, { url: "https://rebinding.example/mcp" }), ctors, {
        fetch: guardedFetch as never,
      })
      expect(calls[0].args[1]).toEqual(
        expect.objectContaining({
          fetch: guardedFetch,
          ...(transport === "sse" ? { eventSourceInit: { fetch: guardedFetch } } : {}),
        })
      )
    }
  })
})

describe("createMcpConnection", () => {
  it("passes the provided clientInfo to the SDK Client", async () => {
    let seen: { name: string; version: string } | undefined
    let options: Record<string, unknown> | undefined
    const load = async () => ({
      Client: class {
        constructor(info: { name: string; version: string }, opts: Record<string, unknown>) {
          seen = info
          options = opts
        }
      } as never,
      ctors: recordingCtors().ctors,
      elicitRequestSchema: {},
    })
    await createMcpConnection(
      srv("stdio", { command: "x" }),
      { clientInfo: { name: "cognia-workflow", version: "1.0.0" } },
      { load }
    )
    expect(seen).toEqual({ name: "cognia-workflow", version: "1.0.0" })
    expect(options).toEqual(
      expect.objectContaining({
        versionNegotiation: { mode: "auto", probe: { timeoutMs: 3000, maxRetries: 0 } },
        supportedProtocolVersions: [...COGNIA_MCP_PROTOCOL_VERSIONS],
        inputRequired: { autoFulfill: true, maxRounds: 8 },
        defaultCacheTtlMs: 0,
      })
    )
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

  it("configures dynamic capability refresh for every semantic list", async () => {
    const onToolsChanged = jest.fn()
    let options: Record<string, unknown> | undefined
    const load = async () => ({
      Client: class {
        constructor(_info: unknown, opts: Record<string, unknown>) {
          options = opts
        }
      } as never,
      ctors: recordingCtors().ctors,
      elicitRequestSchema: {},
    })

    await createMcpConnection(srv("stdio", { command: "x" }), { onToolsChanged }, { load })

    const listChanged = options?.listChanged as Record<
      string,
      { onChanged: (error: Error | null) => void }
    >
    expect(Object.keys(listChanged)).toEqual(["tools", "resources", "prompts"])
    listChanged.resources.onChanged(null)
    expect(onToolsChanged).toHaveBeenCalledTimes(1)
    listChanged.tools.onChanged(new Error("refresh failed"))
    expect(onToolsChanged).toHaveBeenCalledTimes(1)
  })

  it("advertises and registers safe elicitation only when a presenter is supplied", async () => {
    const presenter = jest.fn(async () => ({ action: "decline" as const }))
    const setRequestHandler = jest.fn()
    let options: Record<string, unknown> | undefined
    const schema = { method: "elicitation/create" }
    const load = async () => ({
      Client: class {
        setRequestHandler = setRequestHandler
        constructor(_info: unknown, opts: Record<string, unknown>) {
          options = opts
        }
      } as never,
      ctors: recordingCtors().ctors,
      elicitRequestSchema: schema,
    })

    await createMcpConnection(
      srv("http", { url: "https://figma.example/mcp" }),
      {
        onElicitation: presenter,
      },
      { load }
    )

    expect(options?.capabilities).toEqual({ elicitation: { form: {}, url: {} } })
    expect(setRequestHandler).toHaveBeenCalledWith(schema, expect.any(Function))
    const handler = setRequestHandler.mock.calls[0][1]
    await expect(
      handler({
        params: {
          mode: "url",
          message: "Authorize",
          elicitationId: "e1",
          url: "https://accounts.example.com/authorize",
        },
      })
    ).resolves.toEqual({ action: "decline" })
    expect(presenter).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "url",
        targetHostname: "accounts.example.com",
        provenance: expect.objectContaining({
          serverId: "mcp_s",
          endpoint: "https://figma.example/mcp",
        }),
      })
    )
  })
})

describe("createMcpConnection with the real SDK loader", () => {
  it("loads the SDK and builds a live stdio transport (piped stderr, no spawn)", async () => {
    // No injected `load`: this exercises the real dynamic-import `loadSdk`.
    // Constructing a StdioClientTransport does not spawn a child (that waits for
    // connect), so the test stays side-effect free while covering the loader.
    const { client, transport } = await createMcpConnection(srv("stdio", { command: "true" }))
    expect(typeof client.connect).toBe("function")
    // stderr: "pipe" makes the SDK expose a readable stream — our drain target —
    // instead of inheriting the child's stderr to the terminal.
    expect((transport as { stderr?: unknown }).stderr).toBeTruthy()
  })
})

describe("createMcpConnection stderr capture", () => {
  /** A stderr stub with hand-driven `data`/`error` emission (no timing races). */
  function fakeStderr() {
    const handlers: Record<string, Array<(v: unknown) => void>> = {}
    return {
      on(event: string, cb: (v: unknown) => void) {
        ;(handlers[event] ??= []).push(cb)
        return this
      },
      emit(event: string, v?: unknown) {
        for (const cb of handlers[event] ?? []) cb(v)
      },
    }
  }

  /** A loader whose stdio transport instance exposes `stderr` verbatim. */
  const loadWithStderr = (stderr: unknown) => async () => ({
    Client: class {} as never,
    ctors: {
      Stdio: class {
        stderr = stderr
      } as never,
      Http: class {} as never,
      Sse: class {} as never,
    },
  })

  it("forwards decoded stderr chunks (bytes + strings) to onStderr", async () => {
    const stderr = fakeStderr()
    const seen: string[] = []
    await createMcpConnection(
      srv("stdio", { command: "x" }),
      { onStderr: (c) => seen.push(c) },
      { load: loadWithStderr(stderr) }
    )
    stderr.emit("data", new TextEncoder().encode("Error: missing API key\n"))
    stderr.emit("data", "second line\n")
    stderr.emit("data", 42) // non-string / non-bytes → coerced via String()
    expect(seen.join("")).toBe("Error: missing API key\nsecond line\n42")
  })

  it("drains without a sink and swallows a throwing sink / stream error", async () => {
    const stderr = fakeStderr()
    // No onStderr: the data listener must still consume the chunk (drain) silently.
    await createMcpConnection(srv("stdio", { command: "x" }), {}, { load: loadWithStderr(stderr) })
    expect(() => stderr.emit("data", "noise")).not.toThrow()

    // A throwing sink must not escape the drain, and a stream 'error' is swallowed.
    const stderr2 = fakeStderr()
    await createMcpConnection(
      srv("stdio", { command: "x" }),
      {
        onStderr: () => {
          throw new Error("sink blew up")
        },
      },
      { load: loadWithStderr(stderr2) }
    )
    expect(() => stderr2.emit("data", "boom")).not.toThrow()
    expect(() => stderr2.emit("error", new Error("child died"))).not.toThrow()
  })

  it("is a no-op when the transport exposes no readable stderr", async () => {
    const seen: string[] = []
    // stderr present but not a stream (no `.on`) → skipped without throwing.
    await expect(
      createMcpConnection(
        srv("stdio", { command: "x" }),
        { onStderr: (c) => seen.push(c) },
        { load: loadWithStderr({}) }
      )
    ).resolves.toBeDefined()
    expect(seen).toEqual([])
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
      getNegotiatedProtocolVersion: jest.fn(() => "2026-07-28"),
      getProtocolEra: jest.fn(() => "modern" as const),
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

  it("does not initialize a connection for an already aborted caller", async () => {
    const loader = jest.fn(load(fakeClient()))
    await expect(
      openMcpClient(
        srv("stdio", { command: "x" }),
        { signal: AbortSignal.abort() },
        { load: loader }
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(loader).not.toHaveBeenCalled()
  })

  it("closes setup resources without connecting if cancellation happened during setup", async () => {
    const controller = new AbortController()
    const client = fakeClient()
    const closeGuard = jest.fn(async () => {})
    await expect(
      openMcpClient(
        srv("http", { url: "https://offline.invalid/mcp" }),
        { signal: controller.signal },
        {
          load: load(client),
          createEgressGuard: async () => {
            controller.abort()
            return { fetch: jest.fn(), close: closeGuard }
          },
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(closeGuard).toHaveBeenCalledTimes(1)
  })

  it("connects and returns a closable client", async () => {
    const client = fakeClient()
    const opened = await openMcpClient(srv("stdio", { command: "x" }), {}, { load: load(client) })
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(opened.protocolEra).toBe("modern")
    expect(opened.negotiatedProtocolVersion).toBe("2026-07-28")
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

  it("owns the direct-transport DNS guard for the full remote lease", async () => {
    const client = fakeClient()
    const { ctors, calls } = recordingCtors()
    const guardedFetch = jest.fn()
    const closeGuard = jest.fn(async () => undefined)
    const createEgressGuard = jest.fn(async () => ({ fetch: guardedFetch, close: closeGuard }))
    const opened = await openMcpClient(srv("http", { url: "https://rebinding.example/mcp" }), {}, {
      load: async () => ({
        Client: class {
          constructor() {
            return client as never
          }
        } as never,
        ctors,
      }),
      createEgressGuard,
    } as never)

    expect(createEgressGuard).toHaveBeenCalledWith(false)
    expect(calls[0].args[1]).toEqual(expect.objectContaining({ fetch: guardedFetch }))
    await opened.close()
    expect(closeGuard).toHaveBeenCalledTimes(1)
  })
})
