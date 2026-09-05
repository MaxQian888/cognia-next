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
  it.each([undefined, "", "WRONG"])(
    "rejects callback state %p before token exchange",
    async (state) => {
      const finishAuth = jest.fn()
      const connect = jest.fn().mockRejectedValue({ name: "UnauthorizedError" })
      const result = await authenticateMcpServer(
        remote(),
        baseDeps({
          startCallbackServer: async () => fakeCallback({ code: "CODE", state }),
          createConnection: async () => ({
            client: fakeClient(connect),
            transport: { finishAuth },
          }),
        })
      )
      expect(result).toMatchObject({
        ok: false,
        status: "error",
        message: expect.stringMatching(/state mismatch/i),
      })
      expect(finishAuth).not.toHaveBeenCalled()
    }
  )

  it("does not start anything when already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const startCallbackServer = jest.fn()
    const createConnection = jest.fn()
    const result = await authenticateMcpServer(
      remote(),
      baseDeps({
        signal: controller.signal,
        startCallbackServer,
        createConnection,
      })
    )
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/i) })
    expect(startCallbackServer).not.toHaveBeenCalled()
    expect(createConnection).not.toHaveBeenCalled()
  })

  it("closes the callback and connection when cancelled while awaiting the redirect", async () => {
    const controller = new AbortController()
    const callback = fakeCallback({})
    callback.close = jest.fn()
    const waiting = deferred<void>()
    const redirect = deferred<{ code: string; state: string }>()
    callback.waitForCode = () => {
      waiting.resolve()
      return redirect.promise
    }
    const client = fakeClient(jest.fn().mockRejectedValue({ name: "UnauthorizedError" }))
    const finishAuth = jest.fn()
    const closeEgressGuard = jest.fn(async () => {})
    const result = authenticateMcpServer(
      remote(),
      baseDeps({
        signal: controller.signal,
        startCallbackServer: async () => callback,
        createConnection: async () => ({ client, transport: { finishAuth }, closeEgressGuard }),
      })
    )
    await waiting.promise
    controller.abort()
    expect(await result).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/i) })
    expect(callback.close).toHaveBeenCalledTimes(1)
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(closeEgressGuard).toHaveBeenCalledTimes(1)
    redirect.resolve({ code: "CODE", state: "STATE" })
    await Promise.resolve()
    expect(finishAuth).not.toHaveBeenCalled()
  })

  it("cleans up late callback startup without creating a connection", async () => {
    const controller = new AbortController()
    const pending = deferred<CallbackServer>()
    const callback = fakeCallback({})
    callback.close = jest.fn()
    const createConnection = jest.fn()
    const result = authenticateMcpServer(
      remote(),
      baseDeps({
        signal: controller.signal,
        startCallbackServer: () => pending.promise,
        createConnection,
      })
    )
    controller.abort()
    pending.resolve(callback)
    expect(await result).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/i) })
    expect(callback.close).toHaveBeenCalledTimes(1)
    expect(createConnection).not.toHaveBeenCalled()
  })

  it("blocks browser redirects and cleans up a connection that arrives after cancellation", async () => {
    const controller = new AbortController()
    const started = deferred<void>()
    const pending = deferred<Awaited<ReturnType<NonNullable<AuthFlowDeps["createConnection"]>>>>()
    const openBrowser = jest.fn(async () => true)
    const onAuthUrl = jest.fn()
    let provider!: { redirectToAuthorization: (url: URL) => Promise<void> }
    const client = fakeClient(jest.fn())
    const closeEgressGuard = jest.fn(async () => {})
    const result = authenticateMcpServer(
      remote(),
      baseDeps({
        signal: controller.signal,
        openBrowser,
        onAuthUrl,
        createConnection: async (_server, opts) => {
          provider = opts.authProvider as typeof provider
          started.resolve()
          return pending.promise
        },
      })
    )
    await started.promise
    controller.abort()
    expect(await result).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/i) })
    await expect(provider.redirectToAuthorization(new URL("https://auth/"))).rejects.toThrow(
      /cancelled/i
    )
    pending.resolve({ client, transport: {}, closeEgressGuard })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(openBrowser).not.toHaveBeenCalled()
    expect(onAuthUrl).not.toHaveBeenCalled()
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(closeEgressGuard).toHaveBeenCalledTimes(1)
  })

  it("generates a 256-bit state without Math.random", async () => {
    const random = jest.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("weak RNG")
    })
    let state = ""
    try {
      const result = await authenticateMcpServer(
        remote(),
        baseDeps({
          randomState: undefined,
          createConnection: async (_server, opts) => {
            state = await (opts.authProvider as { state: () => string }).state()
            return { client: fakeClient(jest.fn().mockResolvedValue(undefined)), transport: {} }
          },
        })
      )
      expect(result.ok).toBe(true)
      expect(state).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      random.mockRestore()
    }
  })

  it.each(["connect", "finishAuth"])("cancels pending %s without reconnecting", async (stage) => {
    const controller = new AbortController()
    const started = deferred<void>()
    const pending = deferred<void>()
    const connect = jest.fn(async () => {
      if (stage === "connect") {
        started.resolve()
        return pending.promise
      }
      throw { name: "UnauthorizedError" }
    })
    const finishAuth = jest.fn(() => {
      started.resolve()
      return pending.promise
    })
    const client = fakeClient(connect)
    const result = authenticateMcpServer(
      remote(),
      baseDeps({
        signal: controller.signal,
        createConnection: async () => ({ client, transport: { finishAuth } }),
      })
    )
    await started.promise
    controller.abort()
    expect(await result).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/i) })
    pending.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(connect).toHaveBeenCalledTimes(1)
    expect(finishAuth).toHaveBeenCalledTimes(stage === "connect" ? 0 : 1)
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it("does not open the browser if the URL notification cancels the flow", async () => {
    const controller = new AbortController()
    const openBrowser = jest.fn(async () => true)
    const result = await authenticateMcpServer(
      remote(),
      baseDeps({
        signal: controller.signal,
        openBrowser,
        onAuthUrl: () => controller.abort(),
        createConnection: async (_server, opts) => {
          await (
            opts.authProvider as { redirectToAuthorization: (url: URL) => Promise<void> }
          ).redirectToAuthorization(new URL("https://auth/"))
          throw new Error("unreachable")
        },
      })
    )
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/i) })
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it("reports connection setup failure and releases the callback", async () => {
    const callback = fakeCallback({})
    callback.close = jest.fn()
    const result = await authenticateMcpServer(
      remote(),
      baseDeps({
        startCallbackServer: async () => callback,
        createConnection: async () => {
          throw new Error("setup failed")
        },
      })
    )
    expect(result).toMatchObject({ ok: false, message: "Connection failed: setup failed" })
    expect(callback.close).toHaveBeenCalledTimes(1)
  })

  it("releases the egress guard even when client cleanup fails", async () => {
    const client = fakeClient(jest.fn().mockResolvedValue(undefined))
    client.close = jest.fn().mockRejectedValue(new Error("close failed"))
    const closeEgressGuard = jest.fn(async () => {})
    const result = await authenticateMcpServer(
      remote(),
      baseDeps({
        createConnection: async () => ({ client, transport: {}, closeEgressGuard }),
      })
    )
    expect(result.ok).toBe(true)
    expect(closeEgressGuard).toHaveBeenCalledTimes(1)
  })

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
