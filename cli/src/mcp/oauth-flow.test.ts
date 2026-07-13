/**
 * @jest-environment node
 */
import type { McpServer } from "@cognia/agent-config-types"

import type { McpClientLike, OpenedMcp } from "./mcp-client"
import type { CallbackServer } from "./oauth-callback-server"
import { authenticateMcpServer, type AuthFlowDeps } from "./oauth-flow"
import { type McpAuthFs } from "./oauth-store"

const remote = (over: Partial<McpServer> = {}): McpServer =>
  ({
    id: "mcp_s",
    name: "linear",
    transport: "http",
    config: { url: "https://x" },
    enabled: true,
    ...over,
  }) as McpServer

function memFs(): McpAuthFs {
  const files: Record<string, string> = {}
  return {
    exists: (p) => p in files,
    readText: (p) => files[p],
    writeText: (p, d) => {
      files[p] = d
    },
  }
}

function fakeCallback(
  result: Parameters<CallbackServer["waitForCode"]> extends never
    ? never
    : { code?: string; state?: string; error?: string }
): CallbackServer {
  return {
    redirectUrl: "http://127.0.0.1:9999/callback",
    waitForCode: async () => {
      if (result.error) throw new Error(result.error)
      return result
    },
    close: () => undefined,
  }
}

function fakeClient(connect: jest.Mock): McpClientLike {
  return {
    connect,
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    listPrompts: async () => ({ prompts: [] }),
    close: jest.fn(async () => undefined),
  } as never
}

const baseDeps = (over: Partial<AuthFlowDeps>): AuthFlowDeps => ({
  home: "/home/.cognia",
  fs: memFs(),
  startCallbackServer: async () => fakeCallback({ code: "CODE", state: "STATE" }),
  openBrowser: async () => true,
  randomState: () => "STATE",
  timeoutMs: 1000,
  ...over,
})

describe("authenticateMcpServer", () => {
  it("rejects stdio servers as unsupported", async () => {
    const res = await authenticateMcpServer(
      remote({ transport: "stdio", config: { command: "x" } }),
      baseDeps({})
    )
    expect(res).toMatchObject({ ok: false, status: "unsupported" })
  })

  it("completes the code→finishAuth→reconnect handshake", async () => {
    const finishAuth = jest.fn(async () => undefined)
    // First connect throws Unauthorized (browser), reconnect succeeds.
    const connect = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("401"), { name: "UnauthorizedError" }))
      .mockResolvedValueOnce(undefined)
    const transport = { finishAuth } as OpenedMcp["transport"]
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({
        createConnection: async () => ({ client: fakeClient(connect), transport }),
      })
    )
    expect(res).toMatchObject({ ok: true, status: "authorized" })
    expect(finishAuth).toHaveBeenCalledWith("CODE")
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it("short-circuits when a stored refresh token still connects", async () => {
    const connect = jest.fn().mockResolvedValue(undefined)
    const openBrowser = jest.fn(async () => true)
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({
        openBrowser,
        createConnection: async () => ({
          client: fakeClient(connect),
          transport: { finishAuth: jest.fn() },
        }),
      })
    )
    expect(res).toMatchObject({ ok: true, status: "authorized" })
    expect(res.message).toMatch(/already authorized/i)
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it("returns error on a non-auth connection failure", async () => {
    const connect = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({ createConnection: async () => ({ client: fakeClient(connect), transport: {} }) })
    )
    expect(res).toMatchObject({ ok: false, status: "error" })
    expect(res.message).toMatch(/ECONNREFUSED/)
  })

  it("aborts on a CSRF state mismatch", async () => {
    const connect = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("401"), { name: "UnauthorizedError" }))
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({
        startCallbackServer: async () => fakeCallback({ code: "CODE", state: "WRONG" }),
        createConnection: async () => ({
          client: fakeClient(connect),
          transport: { finishAuth: jest.fn() },
        }),
      })
    )
    expect(res).toMatchObject({ ok: false, status: "error" })
    expect(res.message).toMatch(/state mismatch/i)
  })

  it("reports denial when the user rejects in the browser", async () => {
    const connect = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("401"), { name: "UnauthorizedError" }))
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({
        startCallbackServer: async () => fakeCallback({ error: "access_denied" }),
        createConnection: async () => ({
          client: fakeClient(connect),
          transport: { finishAuth: jest.fn() },
        }),
      })
    )
    expect(res).toMatchObject({ ok: false, status: "denied" })
  })

  it("reports an error when the callback server can't start", async () => {
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({
        startCallbackServer: async () => {
          throw new Error("EADDRINUSE")
        },
      })
    )
    expect(res).toMatchObject({ ok: false, status: "error" })
    expect(res.message).toMatch(/callback server/i)
  })

  it("reports denial when the redirect returns no code", async () => {
    const connect = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("401"), { name: "UnauthorizedError" }))
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({
        startCallbackServer: async () => fakeCallback({ state: "STATE" }), // no code
        createConnection: async () => ({
          client: fakeClient(connect),
          transport: { finishAuth: jest.fn() },
        }),
      })
    )
    expect(res).toMatchObject({ ok: false, status: "denied" })
    expect(res.message).toMatch(/no code/i)
  })

  it("errors when the transport can't finish OAuth", async () => {
    const connect = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("401"), { name: "UnauthorizedError" }))
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({
        createConnection: async () => ({ client: fakeClient(connect), transport: {} }), // no finishAuth
      })
    )
    expect(res).toMatchObject({ ok: false, status: "error" })
    expect(res.message).toMatch(/does not support/i)
  })

  it("errors when token exchange throws", async () => {
    const connect = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("401"), { name: "UnauthorizedError" }))
    const finishAuth = jest.fn(async () => {
      throw new Error("bad_grant")
    })
    const res = await authenticateMcpServer(
      remote(),
      baseDeps({
        createConnection: async () => ({ client: fakeClient(connect), transport: { finishAuth } }),
      })
    )
    expect(res).toMatchObject({ ok: false, status: "error" })
    expect(res.message).toMatch(/Token exchange failed/)
  })

  it("surfaces the auth URL through onAuthUrl", async () => {
    const urls: string[] = []
    const connect = jest.fn().mockResolvedValue(undefined)
    // Trigger redirect path: first connect throws, provider.onRedirect fires.
    connect.mockReset()
    connect
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("401"), { name: "UnauthorizedError" })
      })
      .mockResolvedValueOnce(undefined)
    await authenticateMcpServer(
      remote(),
      baseDeps({
        onAuthUrl: (u) => urls.push(u),
        createConnection: async (_s, opts) => {
          // Simulate the SDK calling redirectToAuthorization during connect.
          const provider = opts.authProvider as {
            redirectToAuthorization: (u: URL) => Promise<void>
          }
          await provider.redirectToAuthorization(new URL("https://auth/authorize?x=1"))
          return { client: fakeClient(connect), transport: { finishAuth: jest.fn() } }
        },
      })
    )
    expect(urls).toEqual(["https://auth/authorize?x=1"])
  })
})
